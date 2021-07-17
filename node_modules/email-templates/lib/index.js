"use strict";

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) { symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); } keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const fs = require('fs');

const path = require('path');

const util = require('util');

const I18N = require('@ladjs/i18n');

const _ = require('lodash');

const consolidate = require('consolidate');

const debug = require('debug')('email-templates');

const getPaths = require('get-paths');

const htmlToText = require('html-to-text');

const juice = require('juice');

const nodemailer = require('nodemailer');

const previewEmail = require('preview-email'); // promise version of `juice.juiceResources`


const juiceResources = (html, options) => {
  return new Promise((resolve, reject) => {
    juice.juiceResources(html, options, (err, html) => {
      if (err) return reject(err);
      resolve(html);
    });
  });
};

const env = (process.env.NODE_ENV || 'development').toLowerCase();
const stat = util.promisify(fs.stat);
const readFile = util.promisify(fs.readFile);

class Email {
  constructor(config = {}) {
    debug('config passed %O', config); // 2.x backwards compatible support

    if (config.juiceOptions) {
      config.juiceResources = config.juiceOptions;
      delete config.juiceOptions;
    }

    if (config.disableJuice) {
      config.juice = false;
      delete config.disableJuice;
    }

    if (config.render) {
      config.customRender = true;
    }

    this.config = _.merge({
      views: {
        // directory where email templates reside
        root: path.resolve('emails'),
        options: {
          // default file extension for template
          extension: 'pug',
          map: {
            hbs: 'handlebars',
            njk: 'nunjucks'
          },
          engineSource: consolidate
        },
        // locals to pass to templates for rendering
        locals: {
          // turn on caching for non-development environments
          cache: !['development', 'test'].includes(env),
          // pretty is automatically set to `false` for subject/text
          pretty: true
        }
      },
      // <https://nodemailer.com/message/>
      message: {},
      send: !['development', 'test'].includes(env),
      preview: env === 'development',
      // <https://github.com/ladjs/i18n>
      // set to an object to configure and enable it
      i18n: false,
      // pass a custom render function if necessary
      render: this.render.bind(this),
      customRender: false,
      // force text-only rendering of template (disregards template folder)
      textOnly: false,
      // <https://github.com/werk85/node-html-to-text>
      htmlToText: {
        ignoreImage: true
      },
      subjectPrefix: false,
      // <https://github.com/Automattic/juice>
      juice: true,
      // Override juice global settings <https://github.com/Automattic/juice#juicecodeblockss>
      juiceSettings: {
        tableElements: ['TABLE']
      },
      juiceResources: {
        preserveImportant: true,
        webResources: {
          relativeTo: path.resolve('build'),
          images: false
        }
      },
      // pass a transport configuration object or a transport instance
      // (e.g. an instance is created via `nodemailer.createTransport`)
      // <https://nodemailer.com/transports/>
      transport: {},
      // last locale field name (also used by @ladjs/i18n)
      lastLocaleField: 'last_locale',

      getPath(type, template) {
        return path.join(template, type);
      }

    }, config); // override existing method

    this.render = this.config.render;
    if (!_.isFunction(this.config.transport.sendMail)) this.config.transport = nodemailer.createTransport(this.config.transport); // Override juice global settings https://github.com/Automattic/juice#juicecodeblocks

    if (_.isObject(this.config.juiceSettings)) {
      for (const [key, value] of Object.entries(this.config.juiceSettings)) {
        juice[key] = value;
      }
    }

    debug('transformed config %O', this.config);
    this.juiceResources = this.juiceResources.bind(this);
    this.getTemplatePath = this.getTemplatePath.bind(this);
    this.templateExists = this.templateExists.bind(this);
    this.checkAndRender = this.checkAndRender.bind(this);
    this.render = this.render.bind(this);
    this.renderAll = this.renderAll.bind(this);
    this.send = this.send.bind(this);
  } // shorthand use of `juiceResources` with the config
  // (mainly for custom renders like from a database)


  juiceResources(html, juiceRenderResources = {}) {
    const juiceR = _.merge(this.config.juiceResources, juiceRenderResources);

    return juiceResources(html, juiceR);
  } // a simple helper function that gets the actual file path for the template


  async getTemplatePath(template) {
    let juiceRenderResources = {};

    if (_.isObject(template)) {
      juiceRenderResources = template.juiceResources;
      template = template.path;
    }

    const [root, view] = path.isAbsolute(template) ? [path.dirname(template), path.basename(template)] : [this.config.views.root, template];
    const paths = await getPaths(root, view, this.config.views.options.extension);
    const filePath = path.resolve(root, paths.rel);
    return {
      filePath,
      paths,
      juiceRenderResources
    };
  } // returns true or false if a template exists
  // (uses same look-up approach as `render` function)


  async templateExists(view) {
    try {
      const {
        filePath
      } = await this.getTemplatePath(view);
      const stats = await stat(filePath);
      if (!stats.isFile()) throw new Error(`${filePath} was not a file`);
      return true;
    } catch (err) {
      debug('templateExists', err);
      return false;
    }
  }

  async checkAndRender(type, template, locals) {
    let juiceRenderResources = {};

    if (_.isObject(template)) {
      juiceRenderResources = template.juiceResources;
      template = template.path;
    }

    const string = this.config.getPath(type, template, locals);

    if (!this.config.customRender) {
      const exists = await this.templateExists(string);
      if (!exists) return;
    }

    return this.render(string, _objectSpread(_objectSpread({}, locals), type === 'html' ? {} : {
      pretty: false
    }), juiceRenderResources);
  } // promise version of consolidate's render
  // inspired by koa-views and re-uses the same config
  // <https://github.com/queckezz/koa-views>


  async render(view, locals = {}) {
    const {
      map,
      engineSource
    } = this.config.views.options;
    const {
      filePath,
      paths,
      juiceRenderResources
    } = await this.getTemplatePath(view);

    if (paths.ext === 'html' && !map) {
      const res = await readFile(filePath, 'utf8');
      return res;
    }

    const engineName = map && map[paths.ext] ? map[paths.ext] : paths.ext;
    const renderFn = engineSource[engineName];
    if (!engineName || !renderFn) throw new Error(`Engine not found for the ".${paths.ext}" file extension`);

    if (_.isObject(this.config.i18n)) {
      if (this.config.i18n.lastLocaleField && this.config.lastLocaleField && this.config.i18n.lastLocaleField !== this.config.lastLocaleField) throw new Error(`The 'lastLocaleField' (String) option for @ladjs/i18n and email-templates do not match, i18n value was ${this.config.i18n.lastLocaleField} and email-templates value was ${this.config.lastLocaleField}`);
      const i18n = new I18N(_objectSpread(_objectSpread({}, this.config.i18n), {}, {
        register: locals
      })); // support `locals.user.last_locale` (variable based name lastLocaleField)
      // (e.g. for <https://lad.js.org>)

      if (_.isObject(locals.user) && _.isString(locals.user[this.config.lastLocaleField])) locals.locale = locals.user[this.config.lastLocaleField];
      if (_.isString(locals.locale)) i18n.setLocale(locals.locale);
    }

    const res = await util.promisify(renderFn)(filePath, locals); // transform the html with juice using remote paths
    // google now supports media queries
    // https://developers.google.com/gmail/design/reference/supported_css

    if (!this.config.juice) return res;
    const html = await this.juiceResources(res, juiceRenderResources);
    return html;
  } // eslint-disable-next-line complexity


  async renderAll(template, locals = {}, nodemailerMessage = {}) {
    const message = _objectSpread({}, nodemailerMessage);

    if (template && (!message.subject || !message.html || !message.text)) {
      const [subject, html, text] = await Promise.all(['subject', 'html', 'text'].map(type => this.checkAndRender(type, template, locals)));
      if (subject && !message.subject) message.subject = subject;
      if (html && !message.html) message.html = html;
      if (text && !message.text) message.text = text;
    }

    if (message.subject && this.config.subjectPrefix) message.subject = this.config.subjectPrefix + message.subject; // trim subject

    if (message.subject) message.subject = message.subject.trim();
    if (this.config.htmlToText && message.html && !message.text) // we'd use nodemailer-html-to-text plugin
      // but we really don't need to support cid
      // <https://github.com/andris9/nodemailer-html-to-text>
      message.text = htmlToText.fromString(message.html, this.config.htmlToText); // if we only want a text-based version of the email

    if (this.config.textOnly) delete message.html; // if no subject, html, or text content exists then we should
    // throw an error that says at least one must be found
    // otherwise the email would be blank (defeats purpose of email-templates)

    if ((!_.isString(message.subject) || _.isEmpty(_.trim(message.subject))) && (!_.isString(message.text) || _.isEmpty(_.trim(message.text))) && (!_.isString(message.html) || _.isEmpty(_.trim(message.html))) && _.isEmpty(message.attachments)) throw new Error(`No content was passed for subject, html, text, nor attachments message props. Check that the files for the template "${template}" exist.`);
    return message;
  }

  async send(options = {}) {
    options = _objectSpread({
      template: '',
      message: {},
      locals: {}
    }, options);
    let {
      template,
      message,
      locals
    } = options;
    const attachments = message.attachments || this.config.message.attachments || [];
    message = _.defaultsDeep({}, _.omit(message, 'attachments'), _.omit(this.config.message, 'attachments'));
    locals = _.defaultsDeep({}, this.config.views.locals, locals);
    if (attachments) message.attachments = attachments;
    debug('template %s', template);
    debug('message %O', message);
    debug('locals (keys only): %O', Object.keys(locals)); // get all available templates

    const object = await this.renderAll(template, locals, message); // assign the object variables over to the message

    Object.assign(message, object);

    if (this.config.preview) {
      debug('using `preview-email` to preview email');
      await (_.isObject(this.config.preview) ? previewEmail(message, this.config.preview) : previewEmail(message));
    }

    if (!this.config.send) {
      debug('send disabled so we are ensuring JSONTransport'); // <https://github.com/nodemailer/nodemailer/issues/798>
      // if (this.config.transport.name !== 'JSONTransport')

      this.config.transport = nodemailer.createTransport({
        jsonTransport: true
      });
    }

    const res = await this.config.transport.sendMail(message);
    debug('message sent');
    res.originalMessage = message;
    return res;
  }

}

module.exports = Email;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9pbmRleC5qcyJdLCJuYW1lcyI6WyJmcyIsInJlcXVpcmUiLCJwYXRoIiwidXRpbCIsIkkxOE4iLCJfIiwiY29uc29saWRhdGUiLCJkZWJ1ZyIsImdldFBhdGhzIiwiaHRtbFRvVGV4dCIsImp1aWNlIiwibm9kZW1haWxlciIsInByZXZpZXdFbWFpbCIsImp1aWNlUmVzb3VyY2VzIiwiaHRtbCIsIm9wdGlvbnMiLCJQcm9taXNlIiwicmVzb2x2ZSIsInJlamVjdCIsImVyciIsImVudiIsInByb2Nlc3MiLCJOT0RFX0VOViIsInRvTG93ZXJDYXNlIiwic3RhdCIsInByb21pc2lmeSIsInJlYWRGaWxlIiwiRW1haWwiLCJjb25zdHJ1Y3RvciIsImNvbmZpZyIsImp1aWNlT3B0aW9ucyIsImRpc2FibGVKdWljZSIsInJlbmRlciIsImN1c3RvbVJlbmRlciIsIm1lcmdlIiwidmlld3MiLCJyb290IiwiZXh0ZW5zaW9uIiwibWFwIiwiaGJzIiwibmprIiwiZW5naW5lU291cmNlIiwibG9jYWxzIiwiY2FjaGUiLCJpbmNsdWRlcyIsInByZXR0eSIsIm1lc3NhZ2UiLCJzZW5kIiwicHJldmlldyIsImkxOG4iLCJiaW5kIiwidGV4dE9ubHkiLCJpZ25vcmVJbWFnZSIsInN1YmplY3RQcmVmaXgiLCJqdWljZVNldHRpbmdzIiwidGFibGVFbGVtZW50cyIsInByZXNlcnZlSW1wb3J0YW50Iiwid2ViUmVzb3VyY2VzIiwicmVsYXRpdmVUbyIsImltYWdlcyIsInRyYW5zcG9ydCIsImxhc3RMb2NhbGVGaWVsZCIsImdldFBhdGgiLCJ0eXBlIiwidGVtcGxhdGUiLCJqb2luIiwiaXNGdW5jdGlvbiIsInNlbmRNYWlsIiwiY3JlYXRlVHJhbnNwb3J0IiwiaXNPYmplY3QiLCJrZXkiLCJ2YWx1ZSIsIk9iamVjdCIsImVudHJpZXMiLCJnZXRUZW1wbGF0ZVBhdGgiLCJ0ZW1wbGF0ZUV4aXN0cyIsImNoZWNrQW5kUmVuZGVyIiwicmVuZGVyQWxsIiwianVpY2VSZW5kZXJSZXNvdXJjZXMiLCJqdWljZVIiLCJ2aWV3IiwiaXNBYnNvbHV0ZSIsImRpcm5hbWUiLCJiYXNlbmFtZSIsInBhdGhzIiwiZmlsZVBhdGgiLCJyZWwiLCJzdGF0cyIsImlzRmlsZSIsIkVycm9yIiwic3RyaW5nIiwiZXhpc3RzIiwiZXh0IiwicmVzIiwiZW5naW5lTmFtZSIsInJlbmRlckZuIiwicmVnaXN0ZXIiLCJ1c2VyIiwiaXNTdHJpbmciLCJsb2NhbGUiLCJzZXRMb2NhbGUiLCJub2RlbWFpbGVyTWVzc2FnZSIsInN1YmplY3QiLCJ0ZXh0IiwiYWxsIiwidHJpbSIsImZyb21TdHJpbmciLCJpc0VtcHR5IiwiYXR0YWNobWVudHMiLCJkZWZhdWx0c0RlZXAiLCJvbWl0Iiwia2V5cyIsIm9iamVjdCIsImFzc2lnbiIsImpzb25UcmFuc3BvcnQiLCJvcmlnaW5hbE1lc3NhZ2UiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBLE1BQU1BLEVBQUUsR0FBR0MsT0FBTyxDQUFDLElBQUQsQ0FBbEI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFDQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUVBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLGFBQUQsQ0FBcEI7O0FBQ0EsTUFBTUksQ0FBQyxHQUFHSixPQUFPLENBQUMsUUFBRCxDQUFqQjs7QUFDQSxNQUFNSyxXQUFXLEdBQUdMLE9BQU8sQ0FBQyxhQUFELENBQTNCOztBQUNBLE1BQU1NLEtBQUssR0FBR04sT0FBTyxDQUFDLE9BQUQsQ0FBUCxDQUFpQixpQkFBakIsQ0FBZDs7QUFDQSxNQUFNTyxRQUFRLEdBQUdQLE9BQU8sQ0FBQyxXQUFELENBQXhCOztBQUNBLE1BQU1RLFVBQVUsR0FBR1IsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTVMsS0FBSyxHQUFHVCxPQUFPLENBQUMsT0FBRCxDQUFyQjs7QUFDQSxNQUFNVSxVQUFVLEdB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QUtuQyxTQUFMLENBQWViLFFBQWYsRUFBeUJ0QixNQUF6QixFQUFpQ0ksT0FBakMsQ0FBckIsQ0EzQnVCLENBNkJ2Qjs7QUFDQTBCLElBQUFBLE1BQU0sQ0FBQ3lDLE1BQVAsQ0FBY25FLE9BQWQsRUFBdUJrRSxNQUF2Qjs7QUFFQSxRQUFJLEtBQUtuRixNQUFMLENBQVltQixPQUFoQixFQUF5QjtBQUN2QnpDLE1BQUFBLEtBQUssQ0FBQyx3Q0FBRCxDQUFMO0FBQ0EsYUFBT0YsQ0FBQyxDQUFDZ0UsUUFBRixDQUFXLEtBQUt4QyxNQUFMLENBQVltQixPQUF2QixJQUNIcEMsWUFBWSxDQUFDa0MsT0FBRCxFQUFVLEtBQUtqQixNQUFMLENBQVltQixPQUF0QixDQURULEdBRUhwQyxZQUFZLENBQUNrQyxPQUFELENBRmhCO0FBR0Q7O0FBRUQsUUFBSSxDQUFDLEtBQUtqQixNQUFMLENBQVlrQixJQUFqQixFQUF1QjtBQUNyQnhDLE1BQUFBLEtBQUssQ0FBQyxnREFBRCxDQUFMLENBRHFCLENBRXJCO0FBQ0E7O0FBQ0EsV0FBS3NCLE1BQUwsQ0FBWStCLFNBQVosR0FBd0JqRCxVQUFVLENBQUN5RCxlQUFYLENBQTJCO0FBQ2pEOEMsUUFBQUEsYUFBYSxFQUFFO0FBRGtDLE9BQTNCLENBQXhCO0FBR0Q7O0FBRUQsVUFBTXJCLEdBQUcsR0FBRyxNQUFNLEtBQUtoRSxNQUFMLENBQVkrQixTQUFaLENBQXNCTyxRQUF0QixDQUErQnJCLE9BQS9CLENBQWxCO0FBQ0F2QyxJQUFBQSxLQUFLLENBQUMsY0FBRCxDQUFMO0FBQ0FzRixJQUFBQSxHQUFHLENBQUNzQixlQUFKLEdBQXNCckUsT0FBdEI7QUFDQSxXQUFPK0MsR0FBUDtBQUNEOztBQXZVUzs7QUEwVVp1QixNQUFNLENBQUNDLE9BQVAsR0FBaUIxRixLQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG5jb25zdCBJMThOID0gcmVxdWlyZSgnQGxhZGpzL2kxOG4nKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IGNvbnNvbGlkYXRlID0gcmVxdWlyZSgnY29uc29saWRhdGUnKTtcbmNvbnN0IGRlYnVnID0gcmVxdWlyZSgnZGVidWcnKSgnZW1haWwtdGVtcGxhdGVzJyk7XG5jb25zdCBnZXRQYXRocyA9IHJlcXVpcmUoJ2dldC1wYXRocycpO1xuY29uc3QgaHRtbFRvVGV4dCA9IHJlcXVpcmUoJ2h0bWwtdG8tdGV4dCcpO1xuY29uc3QganVpY2UgPSByZXF1aXJlKCdqdWljZScpO1xuY29uc3Qgbm9kZW1haWxlciA9IHJlcXVpcmUoJ25vZGVtYWlsZXInKTtcbmNvbnN0IHByZXZpZXdFbWFpbCA9IHJlcXVpcmUoJ3ByZXZpZXctZW1haWwnKTtcblxuLy8gcHJvbWlzZSB2ZXJzaW9uIG9mIGBqdWljZS5qdWljZVJlc291cmNlc2BcbmNvbnN0IGp1aWNlUmVzb3VyY2VzID0gKGh0bWwsIG9wdGlvbnMpID0+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBqdWljZS5qdWljZVJlc291cmNlcyhodG1sLCBvcHRpb25zLCAoZXJyLCBodG1sKSA9PiB7XG4gICAgICBpZiAoZXJyKSByZXR1cm4gcmVqZWN0KGVycik7XG4gICAgICByZXNvbHZlKGh0bWwpO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbmNvbnN0IGVudiA9IChwcm9jZXNzLmVudi5OT0RFX0VOViB8fCAnZGV2ZWxvcG1lbnQnKS50b0xvd2VyQ2FzZSgpO1xuY29uc3Qgc3RhdCA9IHV0aWwucHJvbWlzaWZ5KGZzLnN0YXQpO1xuY29uc3QgcmVhZEZpbGUgPSB1dGlsLnByb21pc2lmeShmcy5yZWFkRmlsZSk7XG5cbmNsYXNzIEVtYWlsIHtcbiAgY29uc3RydWN0b3IoY29uZmlnID0ge30pIHtcbiAgICBkZWJ1ZygnY29uZmlnIHBhc3NlZCAlTycsIGNvbmZpZyk7XG5cbiAgICAvLyAyLnggYmFja3dhcmRzIGNvbXBhdGlibGUgc3VwcG9ydFxuICAgIGlmIChjb25maWcuanVpY2VPcHRpb25zKSB7XG4gICAgICBjb25maWcuanVpY2VSZXNvdXJjZXMgPSBjb25maWcuanVpY2VPcHRpb25zO1xuICAgICAgZGVsZXRlIGNvbmZpZy5qdWljZU9wdGlvbnM7XG4gICAgfVxuXG4gICAgaWYgKGNvbmZpZy5kaXNhYmxlSnVpY2UpIHtcbiAgICAgIGNvbmZpZy5qdWljZSA9IGZhbHNlO1xuICAgICAgZGVsZXRlIGNvbmZpZy5kaXNhYmxlSnVpY2U7XG4gICAgfVxuXG4gICAgaWYgKGNvbmZpZy5yZW5kZXIpIHtcbiAgICAgIGNvbmZpZy5jdXN0b21SZW5kZXIgPSB0cnVlO1xuICAgIH1cblxuICAgIHRoaXMuY29uZmlnID0gXy5tZXJnZShcbiAgICAgIHtcbiAgICAgICAgdmlld3M6IHtcbiAgICAgICAgICAvLyBkaXJlY3Rvcnkgd2hlcmUgZW1haWwgdGVtcGxhdGVzIHJlc2lkZVxuICAgICAgICAgIHJvb3Q6IHBhdGgucmVzb2x2ZSgnZW1haWxzJyksXG4gICAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgICAgLy8gZGVmYXVsdCBmaWxlIGV4dGVuc2lvbiBmb3IgdGVtcGxhdGVcbiAgICAgICAgICAgIGV4dGVuc2lvbjogJ3B1ZycsXG4gICAgICAgICAgICBtYXA6IHtcbiAgICAgICAgICAgICAgaGJzOiAnaGFuZGxlYmFycycsXG4gICAgICAgICAgICAgIG5qazogJ251bmp1Y2tzJ1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGVuZ2luZVNvdXJjZTogY29uc29saWRhdGVcbiAgICAgICAgICB9LFxuICAgICAgICAgIC8vIGxvY2FscyB0byBwYXNzIHRvIHRlbXBsYXRlcyBmb3IgcmVuZGVyaW5nXG4gICAgICAgICAgbG9jYWxzOiB7XG4gICAgICAgICAgICAvLyB0dXJuIG9uIGNhY2hpbmcgZm9yIG5vbi1kZXZlbG9wbWVudCBlbnZpcm9ubWVudHNcbiAgICAgICAgICAgIGNhY2hlOiAhWydkZXZlbG9wbWVudCcsICd0ZXN0J10uaW5jbHVkZXMoZW52KSxcbiAgICAgICAgICAgIC8vIHByZXR0eSBpcyBhdXRvbWF0aWNhbGx5IHNldCB0byBgZmFsc2VgIGZvciBzdWJqZWN0L3RleHRcbiAgICAgICAgICAgIHByZXR0eTogdHJ1ZVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgLy8gPGh0dHBzOi8vbm9kZW1haWxlci5jb20vbWVzc2FnZS8+XG4gICAgICAgIG1lc3NhZ2U6IHt9LFxuICAgICAgICBzZW5kOiAhWydkZXZlbG9wbWVudCcsICd0ZXN0J10uaW5jbHVkZXMoZW52KSxcbiAgICAgICAgcHJldmlldzogZW52ID09PSAnZGV2ZWxvcG1lbnQnLFxuICAgICAgICAvLyA8aHR0cHM6Ly9naXRodWIuY29tL2xhZGpzL2kxOG4+XG4gICAgICAgIC8vIHNldCB0byBhbiBvYmplY3QgdG8gY29uZmlndXJlIGFuZCBlbmFibGUgaXRcbiAgICAgICAgaTE4bjogZmFsc2UsXG4gICAgICAgIC8vIHBhc3MgYSBjdXN0b20gcmVuZGVyIGZ1bmN0aW9uIGlmIG5lY2Vzc2FyeVxuICAgICAgICByZW5kZXI6IHRoaXMucmVuZGVyLmJpbmQodGhpcyksXG4gICAgICAgIGN1c3RvbVJlbmRlcjogZmFsc2UsXG4gICAgICAgIC8vIGZvcmNlIHRleHQtb25seSByZW5kZXJpbmcgb2YgdGVtcGxhdGUgKGRpc3JlZ2FyZHMgdGVtcGxhdGUgZm9sZGVyKVxuICAgICAgICB0ZXh0T25seTogZmFsc2UsXG4gICAgICAgIC8vIDxodHRwczovL2dpdGh1Yi5jb20vd2Vyazg1L25vZGUtaHRtbC10by10ZXh0PlxuICAgICAgICBodG1sVG9UZXh0OiB7XG4gICAgICAgICAgaWdub3JlSW1hZ2U6IHRydWVcbiAgICAgICAgfSxcbiAgICAgICAgc3ViamVjdFByZWZpeDogZmFsc2UsXG4gICAgICAgIC8vIDxodHRwczovL2dpdGh1Yi5jb20vQXV0b21hdHRpYy9qdWljZT5cbiAgICAgICAganVpY2U6IHRydWUsXG4gICAgICAgIC8vIE92ZXJyaWRlIGp1aWNlIGdsb2JhbCBzZXR0aW5ncyA8aHR0cHM6Ly9naXRodWIuY29tL0F1dG9tYXR0aWMvanVpY2UjanVpY2Vjb2RlYmxvY2tzcz5cbiAgICAgICAganVpY2VTZXR0aW5nczoge1xuICAgICAgICAgIHRhYmxlRWxlbWVudHM6IFsnVEFCTEUnXVxuICAgICAgICB9LFxuICAgICAgICBqdWljZVJlc291cmNlczoge1xuICAgICAgICAgIHByZXNlcnZlSW1wb3J0YW50OiB0cnVlLFxuICAgICAgICAgIHdlYlJlc291cmNlczoge1xuICAgICAgICAgICAgcmVsYXRpdmVUbzogcGF0aC5yZXNvbHZlKCdidWlsZCcpLFxuICAgICAgICAgICAgaW1hZ2VzOiBmYWxzZVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgLy8gcGFzcyBhIHRyYW5zcG9ydCBjb25maWd1cmF0aW9uIG9iamVjdCBvciBhIHRyYW5zcG9ydCBpbnN0YW5jZVxuICAgICAgICAvLyAoZS5nLiBhbiBpbnN0YW5jZSBpcyBjcmVhdGVkIHZpYSBgbm9kZW1haWxlci5jcmVhdGVUcmFuc3BvcnRgKVxuICAgICAgICAvLyA8aHR0cHM6Ly9ub2RlbWFpbGVyLmNvbS90cmFuc3BvcnRzLz5cbiAgICAgICAgdHJhbnNwb3J0OiB7fSxcbiAgICAgICAgLy8gbGFzdCBsb2NhbGUgZmllbGQgbmFtZSAoYWxzbyB1c2VkIGJ5IEBsYWRqcy9pMThuKVxuICAgICAgICBsYXN0TG9jYWxlRmllbGQ6ICdsYXN0X2xvY2FsZScsXG4gICAgICAgIGdldFBhdGgodHlwZSwgdGVtcGxhdGUpIHtcbiAgICAgICAgICByZXR1cm4gcGF0aC5qb2luKHRlbXBsYXRlLCB0eXBlKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNvbmZpZ1xuICAgICk7XG5cbiAgICAvLyBvdmVycmlkZSBleGlzdGluZyBtZXRob2RcbiAgICB0aGlzLnJlbmRlciA9IHRoaXMuY29uZmlnLnJlbmRlcjtcblxuICAgIGlmICghXy5pc0Z1bmN0aW9uKHRoaXMuY29uZmlnLnRyYW5zcG9ydC5zZW5kTWFpbCkpXG4gICAgICB0aGlzLmNvbmZpZy50cmFuc3BvcnQgPSBub2RlbWFpbGVyLmNyZWF0ZVRyYW5zcG9ydCh0aGlzLmNvbmZpZy50cmFuc3BvcnQpO1xuXG4gICAgLy8gT3ZlcnJpZGUganVpY2UgZ2xvYmFsIHNldHRpbmdzIGh0dHBzOi8vZ2l0aHViLmNvbS9BdXRvbWF0dGljL2p1aWNlI2p1aWNlY29kZWJsb2Nrc1xuICAgIGlmIChfLmlzT2JqZWN0KHRoaXMuY29uZmlnLmp1aWNlU2V0dGluZ3MpKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh0aGlzLmNvbmZpZy5qdWljZVNldHRpbmdzKSkge1xuICAgICAgICBqdWljZVtrZXldID0gdmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZGVidWcoJ3RyYW5zZm9ybWVkIGNvbmZpZyAlTycsIHRoaXMuY29uZmlnKTtcblxuICAgIHRoaXMuanVpY2VSZXNvdXJjZXMgPSB0aGlzLmp1aWNlUmVzb3VyY2VzLmJpbmQodGhpcyk7XG4gICAgdGhpcy5nZXRUZW1wbGF0ZVBhdGggPSB0aGlzLmdldFRlbXBsYXRlUGF0aC5iaW5kKHRoaXMpO1xuICAgIHRoaXMudGVtcGxhdGVFeGlzdHMgPSB0aGlzLnRlbXBsYXRlRXhpc3RzLmJpbmQodGhpcyk7XG4gICAgdGhpcy5jaGVja0FuZFJlbmRlciA9IHRoaXMuY2hlY2tBbmRSZW5kZXIuYmluZCh0aGlzKTtcbiAgICB0aGlzLnJlbmRlciA9IHRoaXMucmVuZGVyLmJpbmQodGhpcyk7XG4gICAgdGhpcy5yZW5kZXJBbGwgPSB0aGlzLnJlbmRlckFsbC5iaW5kKHRoaXMpO1xuICAgIHRoaXMuc2VuZCA9IHRoaXMuc2VuZC5iaW5kKHRoaXMpO1xuICB9XG5cbiAgLy8gc2hvcnRoYW5kIHVzZSBvZiBganVpY2VSZXNvdXJjZXNgIHdpdGggdGhlIGNvbmZpZ1xuICAvLyAobWFpbmx5IGZvciBjdXN0b20gcmVuZGVycyBsaWtlIGZyb20gYSBkYXRhYmFzZSlcbiAganVpY2VSZXNvdXJjZXMoaHRtbCwganVpY2VSZW5kZXJSZXNvdXJjZXMgPSB7fSkge1xuICAgIGNvbnN0IGp1aWNlUiA9IF8ubWVyZ2UodGhpcy5jb25maWcuanVpY2VSZXNvdXJjZXMsIGp1aWNlUmVuZGVyUmVzb3VyY2VzKTtcbiAgICByZXR1cm4ganVpY2VSZXNvdXJjZXMoaHRtbCwganVpY2VSKTtcbiAgfVxuXG4gIC8vIGEgc2ltcGxlIGhlbHBlciBmdW5jdGlvbiB0aGF0IGdldHMgdGhlIGFjdHVhbCBmaWxlIHBhdGggZm9yIHRoZSB0ZW1wbGF0ZVxuICBhc3luYyBnZXRUZW1wbGF0ZVBhdGgodGVtcGxhdGUpIHtcbiAgICBsZXQganVpY2VSZW5kZXJSZXNvdXJjZXMgPSB7fTtcblxuICAgIGlmIChfLmlzT2JqZWN0KHRlbXBsYXRlKSkge1xuICAgICAganVpY2VSZW5kZXJSZXNvdXJjZXMgPSB0ZW1wbGF0ZS5qdWljZVJlc291cmNlcztcbiAgICAgIHRlbXBsYXRlID0gdGVtcGxhdGUucGF0aDtcbiAgICB9XG5cbiAgICBjb25zdCBbcm9vdCwgdmlld10gPSBwYXRoLmlzQWJzb2x1dGUodGVtcGxhdGUpXG4gICAgICA/IFtwYXRoLmRpcm5hbWUodGVtcGxhdGUpLCBwYXRoLmJhc2VuYW1lKHRlbXBsYXRlKV1cbiAgICAgIDogW3RoaXMuY29uZmlnLnZpZXdzLnJvb3QsIHRlbXBsYXRlXTtcbiAgICBjb25zdCBwYXRocyA9IGF3YWl0IGdldFBhdGhzKFxuICAgICAgcm9vdCxcbiAgICAgIHZpZXcsXG4gICAgICB0aGlzLmNvbmZpZy52aWV3cy5vcHRpb25zLmV4dGVuc2lvblxuICAgICk7XG4gICAgY29uc3QgZmlsZVBhdGggPSBwYXRoLnJlc29sdmUocm9vdCwgcGF0aHMucmVsKTtcbiAgICByZXR1cm4geyBmaWxlUGF0aCwgcGF0aHMsIGp1aWNlUmVuZGVyUmVzb3VyY2VzIH07XG4gIH1cblxuICAvLyByZXR1cm5zIHRydWUgb3IgZmFsc2UgaWYgYSB0ZW1wbGF0ZSBleGlzdHNcbiAgLy8gKHVzZXMgc2FtZSBsb29rLXVwIGFwcHJvYWNoIGFzIGByZW5kZXJgIGZ1bmN0aW9uKVxuICBhc3luYyB0ZW1wbGF0ZUV4aXN0cyh2aWV3KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZmlsZVBhdGggfSA9IGF3YWl0IHRoaXMuZ2V0VGVtcGxhdGVQYXRoKHZpZXcpO1xuICAgICAgY29uc3Qgc3RhdHMgPSBhd2FpdCBzdGF0KGZpbGVQYXRoKTtcbiAgICAgIGlmICghc3RhdHMuaXNGaWxlKCkpIHRocm93IG5ldyBFcnJvcihgJHtmaWxlUGF0aH0gd2FzIG5vdCBhIGZpbGVgKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZGVidWcoJ3RlbXBsYXRlRXhpc3RzJywgZXJyKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBjaGVja0FuZFJlbmRlcih0eXBlLCB0ZW1wbGF0ZSwgbG9jYWxzKSB7XG4gICAgbGV0IGp1aWNlUmVuZGVyUmVzb3VyY2VzID0ge307XG5cbiAgICBpZiAoXy5pc09iamVjdCh0ZW1wbGF0ZSkpIHtcbiAgICAgIGp1aWNlUmVuZGVyUmVzb3VyY2VzID0gdGVtcGxhdGUuanVpY2VSZXNvdXJjZXM7XG4gICAgICB0ZW1wbGF0ZSA9IHRlbXBsYXRlLnBhdGg7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RyaW5nID0gdGhpcy5jb25maWcuZ2V0UGF0aCh0eXBlLCB0ZW1wbGF0ZSwgbG9jYWxzKTtcbiAgICBpZiAoIXRoaXMuY29uZmlnLmN1c3RvbVJlbmRlcikge1xuICAgICAgY29uc3QgZXhpc3RzID0gYXdhaXQgdGhpcy50ZW1wbGF0ZUV4aXN0cyhzdHJpbmcpO1xuICAgICAgaWYgKCFleGlzdHMpIHJldHVybjtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5yZW5kZXIoXG4gICAgICBzdHJpbmcsXG4gICAgICB7XG4gICAgICAgIC4uLmxvY2FscyxcbiAgICAgICAgLi4uKHR5cGUgPT09ICdodG1sJyA/IHt9IDogeyBwcmV0dHk6IGZhbHNlIH0pXG4gICAgICB9LFxuICAgICAganVpY2VSZW5kZXJSZXNvdXJjZXNcbiAgICApO1xuICB9XG5cbiAgLy8gcHJvbWlzZSB2ZXJzaW9uIG9mIGNvbnNvbGlkYXRlJ3MgcmVuZGVyXG4gIC8vIGluc3BpcmVkIGJ5IGtvYS12aWV3cyBhbmQgcmUtdXNlcyB0aGUgc2FtZSBjb25maWdcbiAgLy8gPGh0dHBzOi8vZ2l0aHViLmNvbS9xdWVja2V6ei9rb2Etdmlld3M+XG4gIGFzeW5jIHJlbmRlcih2aWV3LCBsb2NhbHMgPSB7fSkge1xuICAgIGNvbnN0IHsgbWFwLCBlbmdpbmVTb3VyY2UgfSA9IHRoaXMuY29uZmlnLnZpZXdzLm9wdGlvbnM7XG4gICAgY29uc3QgeyBmaWxlUGF0aCwgcGF0aHMsIGp1aWNlUmVuZGVyUmVzb3VyY2VzIH0gPVxuICAgICAgYXdhaXQgdGhpcy5nZXRUZW1wbGF0ZVBhdGgodmlldyk7XG4gICAgaWYgKHBhdGhzLmV4dCA9PT0gJ2h0bWwnICYmICFtYXApIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHJlYWRGaWxlKGZpbGVQYXRoLCAndXRmOCcpO1xuICAgICAgcmV0dXJuIHJlcztcbiAgICB9XG5cbiAgICBjb25zdCBlbmdpbmVOYW1lID0gbWFwICYmIG1hcFtwYXRocy5leHRdID8gbWFwW3BhdGhzLmV4dF0gOiBwYXRocy5leHQ7XG4gICAgY29uc3QgcmVuZGVyRm4gPSBlbmdpbmVTb3VyY2VbZW5naW5lTmFtZV07XG4gICAgaWYgKCFlbmdpbmVOYW1lIHx8ICFyZW5kZXJGbilcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEVuZ2luZSBub3QgZm91bmQgZm9yIHRoZSBcIi4ke3BhdGhzLmV4dH1cIiBmaWxlIGV4dGVuc2lvbmBcbiAgICAgICk7XG5cbiAgICBpZiAoXy5pc09iamVjdCh0aGlzLmNvbmZpZy5pMThuKSkge1xuICAgICAgaWYgKFxuICAgICAgICB0aGlzLmNvbmZpZy5pMThuLmxhc3RMb2NhbGVGaWVsZCAmJlxuICAgICAgICB0aGlzLmNvbmZpZy5sYXN0TG9jYWxlRmllbGQgJiZcbiAgICAgICAgdGhpcy5jb25maWcuaTE4bi5sYXN0TG9jYWxlRmllbGQgIT09IHRoaXMuY29uZmlnLmxhc3RMb2NhbGVGaWVsZFxuICAgICAgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFRoZSAnbGFzdExvY2FsZUZpZWxkJyAoU3RyaW5nKSBvcHRpb24gZm9yIEBsYWRqcy9pMThuIGFuZCBlbWFpbC10ZW1wbGF0ZXMgZG8gbm90IG1hdGNoLCBpMThuIHZhbHVlIHdhcyAke3RoaXMuY29uZmlnLmkxOG4ubGFzdExvY2FsZUZpZWxkfSBhbmQgZW1haWwtdGVtcGxhdGVzIHZhbHVlIHdhcyAke3RoaXMuY29uZmlnLmxhc3RMb2NhbGVGaWVsZH1gXG4gICAgICAgICk7XG5cbiAgICAgIGNvbnN0IGkxOG4gPSBuZXcgSTE4Tih7IC4uLnRoaXMuY29uZmlnLmkxOG4sIHJlZ2lzdGVyOiBsb2NhbHMgfSk7XG5cbiAgICAgIC8vIHN1cHBvcnQgYGxvY2Fscy51c2VyLmxhc3RfbG9jYWxlYCAodmFyaWFibGUgYmFzZWQgbmFtZSBsYXN0TG9jYWxlRmllbGQpXG4gICAgICAvLyAoZS5nLiBmb3IgPGh0dHBzOi8vbGFkLmpzLm9yZz4pXG4gICAgICBpZiAoXG4gICAgICAgIF8uaXNPYmplY3QobG9jYWxzLnVzZXIpICYmXG4gICAgICAgIF8uaXNTdHJpbmcobG9jYWxzLnVzZXJbdGhpcy5jb25maWcubGFzdExvY2FsZUZpZWxkXSlcbiAgICAgIClcbiAgICAgICAgbG9jYWxzLmxvY2FsZSA9IGxvY2Fscy51c2VyW3RoaXMuY29uZmlnLmxhc3RMb2NhbGVGaWVsZF07XG5cbiAgICAgIGlmIChfLmlzU3RyaW5nKGxvY2Fscy5sb2NhbGUpKSBpMThuLnNldExvY2FsZShsb2NhbHMubG9jYWxlKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB1dGlsLnByb21pc2lmeShyZW5kZXJGbikoZmlsZVBhdGgsIGxvY2Fscyk7XG4gICAgLy8gdHJhbnNmb3JtIHRoZSBodG1sIHdpdGgganVpY2UgdXNpbmcgcmVtb3RlIHBhdGhzXG4gICAgLy8gZ29vZ2xlIG5vdyBzdXBwb3J0cyBtZWRpYSBxdWVyaWVzXG4gICAgLy8gaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZ21haWwvZGVzaWduL3JlZmVyZW5jZS9zdXBwb3J0ZWRfY3NzXG4gICAgaWYgKCF0aGlzLmNvbmZpZy5qdWljZSkgcmV0dXJuIHJlcztcbiAgICBjb25zdCBodG1sID0gYXdhaXQgdGhpcy5qdWljZVJlc291cmNlcyhyZXMsIGp1aWNlUmVuZGVyUmVzb3VyY2VzKTtcbiAgICByZXR1cm4gaHRtbDtcbiAgfVxuXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjb21wbGV4aXR5XG4gIGFzeW5jIHJlbmRlckFsbCh0ZW1wbGF0ZSwgbG9jYWxzID0ge30sIG5vZGVtYWlsZXJNZXNzYWdlID0ge30pIHtcbiAgICBjb25zdCBtZXNzYWdlID0geyAuLi5ub2RlbWFpbGVyTWVzc2FnZSB9O1xuXG4gICAgaWYgKHRlbXBsYXRlICYmICghbWVzc2FnZS5zdWJqZWN0IHx8ICFtZXNzYWdlLmh0bWwgfHwgIW1lc3NhZ2UudGV4dCkpIHtcbiAgICAgIGNvbnN0IFtzdWJqZWN0LCBodG1sLCB0ZXh0XSA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICBbJ3N1YmplY3QnLCAnaHRtbCcsICd0ZXh0J10ubWFwKCh0eXBlKSA9PlxuICAgICAgICAgIHRoaXMuY2hlY2tBbmRSZW5kZXIodHlwZSwgdGVtcGxhdGUsIGxvY2FscylcbiAgICAgICAgKVxuICAgICAgKTtcblxuICAgICAgaWYgKHN1YmplY3QgJiYgIW1lc3NhZ2Uuc3ViamVjdCkgbWVzc2FnZS5zdWJqZWN0ID0gc3ViamVjdDtcbiAgICAgIGlmIChodG1sICYmICFtZXNzYWdlLmh0bWwpIG1lc3NhZ2UuaHRtbCA9IGh0bWw7XG4gICAgICBpZiAodGV4dCAmJiAhbWVzc2FnZS50ZXh0KSBtZXNzYWdlLnRleHQgPSB0ZXh0O1xuICAgIH1cblxuICAgIGlmIChtZXNzYWdlLnN1YmplY3QgJiYgdGhpcy5jb25maWcuc3ViamVjdFByZWZpeClcbiAgICAgIG1lc3NhZ2Uuc3ViamVjdCA9IHRoaXMuY29uZmlnLnN1YmplY3RQcmVmaXggKyBtZXNzYWdlLnN1YmplY3Q7XG5cbiAgICAvLyB0cmltIHN1YmplY3RcbiAgICBpZiAobWVzc2FnZS5zdWJqZWN0KSBtZXNzYWdlLnN1YmplY3QgPSBtZXNzYWdlLnN1YmplY3QudHJpbSgpO1xuXG4gICAgaWYgKHRoaXMuY29uZmlnLmh0bWxUb1RleHQgJiYgbWVzc2FnZS5odG1sICYmICFtZXNzYWdlLnRleHQpXG4gICAgICAvLyB3ZSdkIHVzZSBub2RlbWFpbGVyLWh0bWwtdG8tdGV4dCBwbHVnaW5cbiAgICAgIC8vIGJ1dCB3ZSByZWFsbHkgZG9uJ3QgbmVlZCB0byBzdXBwb3J0IGNpZFxuICAgICAgLy8gPGh0dHBzOi8vZ2l0aHViLmNvbS9hbmRyaXM5L25vZGVtYWlsZXItaHRtbC10by10ZXh0PlxuICAgICAgbWVzc2FnZS50ZXh0ID0gaHRtbFRvVGV4dC5mcm9tU3RyaW5nKFxuICAgICAgICBtZXNzYWdlLmh0bWwsXG4gICAgICAgIHRoaXMuY29uZmlnLmh0bWxUb1RleHRcbiAgICAgICk7XG5cbiAgICAvLyBpZiB3ZSBvbmx5IHdhbnQgYSB0ZXh0LWJhc2VkIHZlcnNpb24gb2YgdGhlIGVtYWlsXG4gICAgaWYgKHRoaXMuY29uZmlnLnRleHRPbmx5KSBkZWxldGUgbWVzc2FnZS5odG1sO1xuXG4gICAgLy8gaWYgbm8gc3ViamVjdCwgaHRtbCwgb3IgdGV4dCBjb250ZW50IGV4aXN0cyB0aGVuIHdlIHNob3VsZFxuICAgIC8vIHRocm93IGFuIGVycm9yIHRoYXQgc2F5cyBhdCBsZWFzdCBvbmUgbXVzdCBiZSBmb3VuZFxuICAgIC8vIG90aGVyd2lzZSB0aGUgZW1haWwgd291bGQgYmUgYmxhbmsgKGRlZmVhdHMgcHVycG9zZSBvZiBlbWFpbC10ZW1wbGF0ZXMpXG4gICAgaWYgKFxuICAgICAgKCFfLmlzU3RyaW5nKG1lc3NhZ2Uuc3ViamVjdCkgfHwgXy5pc0VtcHR5KF8udHJpbShtZXNzYWdlLnN1YmplY3QpKSkgJiZcbiAgICAgICghXy5pc1N0cmluZyhtZXNzYWdlLnRleHQpIHx8IF8uaXNFbXB0eShfLnRyaW0obWVzc2FnZS50ZXh0KSkpICYmXG4gICAgICAoIV8uaXNTdHJpbmcobWVzc2FnZS5odG1sKSB8fCBfLmlzRW1wdHkoXy50cmltKG1lc3NhZ2UuaHRtbCkpKSAmJlxuICAgICAgXy5pc0VtcHR5KG1lc3NhZ2UuYXR0YWNobWVudHMpXG4gICAgKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgTm8gY29udGVudCB3YXMgcGFzc2VkIGZvciBzdWJqZWN0LCBodG1sLCB0ZXh0LCBub3IgYXR0YWNobWVudHMgbWVzc2FnZSBwcm9wcy4gQ2hlY2sgdGhhdCB0aGUgZmlsZXMgZm9yIHRoZSB0ZW1wbGF0ZSBcIiR7dGVtcGxhdGV9XCIgZXhpc3QuYFxuICAgICAgKTtcblxuICAgIHJldHVybiBtZXNzYWdlO1xuICB9XG5cbiAgYXN5bmMgc2VuZChvcHRpb25zID0ge30pIHtcbiAgICBvcHRpb25zID0ge1xuICAgICAgdGVtcGxhdGU6ICcnLFxuICAgICAgbWVzc2FnZToge30sXG4gICAgICBsb2NhbHM6IHt9LFxuICAgICAgLi4ub3B0aW9uc1xuICAgIH07XG5cbiAgICBsZXQgeyB0ZW1wbGF0ZSwgbWVzc2FnZSwgbG9jYWxzIH0gPSBvcHRpb25zO1xuXG4gICAgY29uc3QgYXR0YWNobWVudHMgPVxuICAgICAgbWVzc2FnZS5hdHRhY2htZW50cyB8fCB0aGlzLmNvbmZpZy5tZXNzYWdlLmF0dGFjaG1lbnRzIHx8IFtdO1xuXG4gICAgbWVzc2FnZSA9IF8uZGVmYXVsdHNEZWVwKFxuICAgICAge30sXG4gICAgICBfLm9taXQobWVzc2FnZSwgJ2F0dGFjaG1lbnRzJyksXG4gICAgICBfLm9taXQodGhpcy5jb25maWcubWVzc2FnZSwgJ2F0dGFjaG1lbnRzJylcbiAgICApO1xuICAgIGxvY2FscyA9IF8uZGVmYXVsdHNEZWVwKHt9LCB0aGlzLmNvbmZpZy52aWV3cy5sb2NhbHMsIGxvY2Fscyk7XG5cbiAgICBpZiAoYXR0YWNobWVudHMpIG1lc3NhZ2UuYXR0YWNobWVudHMgPSBhdHRhY2htZW50cztcblxuICAgIGRlYnVnKCd0ZW1wbGF0ZSAlcycsIHRlbXBsYXRlKTtcbiAgICBkZWJ1ZygnbWVzc2FnZSAlTycsIG1lc3NhZ2UpO1xuICAgIGRlYnVnKCdsb2NhbHMgKGtleXMgb25seSk6ICVPJywgT2JqZWN0LmtleXMobG9jYWxzKSk7XG5cbiAgICAvLyBnZXQgYWxsIGF2YWlsYWJsZSB0ZW1wbGF0ZXNcbiAgICBjb25zdCBvYmplY3QgPSBhd2FpdCB0aGlzLnJlbmRlckFsbCh0ZW1wbGF0ZSwgbG9jYWxzLCBtZXNzYWdlKTtcblxuICAgIC8vIGFzc2lnbiB0aGUgb2JqZWN0IHZhcmlhYmxlcyBvdmVyIHRvIHRoZSBtZXNzYWdlXG4gICAgT2JqZWN0LmFzc2lnbihtZXNzYWdlLCBvYmplY3QpO1xuXG4gICAgaWYgKHRoaXMuY29uZmlnLnByZXZpZXcpIHtcbiAgICAgIGRlYnVnKCd1c2luZyBgcHJldmlldy1lbWFpbGAgdG8gcHJldmlldyBlbWFpbCcpO1xuICAgICAgYXdhaXQgKF8uaXNPYmplY3QodGhpcy5jb25maWcucHJldmlldylcbiAgICAgICAgPyBwcmV2aWV3RW1haWwobWVzc2FnZSwgdGhpcy5jb25maWcucHJldmlldylcbiAgICAgICAgOiBwcmV2aWV3RW1haWwobWVzc2FnZSkpO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5jb25maWcuc2VuZCkge1xuICAgICAgZGVidWcoJ3NlbmQgZGlzYWJsZWQgc28gd2UgYXJlIGVuc3VyaW5nIEpTT05UcmFuc3BvcnQnKTtcbiAgICAgIC8vIDxodHRwczovL2dpdGh1Yi5jb20vbm9kZW1haWxlci9ub2RlbWFpbGVyL2lzc3Vlcy83OTg+XG4gICAgICAvLyBpZiAodGhpcy5jb25maWcudHJhbnNwb3J0Lm5hbWUgIT09ICdKU09OVHJhbnNwb3J0JylcbiAgICAgIHRoaXMuY29uZmlnLnRyYW5zcG9ydCA9IG5vZGVtYWlsZXIuY3JlYXRlVHJhbnNwb3J0KHtcbiAgICAgICAganNvblRyYW5zcG9ydDogdHJ1ZVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5jb25maWcudHJhbnNwb3J0LnNlbmRNYWlsKG1lc3NhZ2UpO1xuICAgIGRlYnVnKCdtZXNzYWdlIHNlbnQnKTtcbiAgICByZXMub3JpZ2luYWxNZXNzYWdlID0gbWVzc2FnZTtcbiAgICByZXR1cm4gcmVzO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW1haWw7XG4iXX0=