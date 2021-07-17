const nodemailer = require("nodemailer");
require("dotenv").config();
const fs = require("fs")
const handlebars = require("handlebars");

require.extensions['.handlebars'] = function (module, filename) {
  module.exports = fs.readFileSync(filename, 'utf8');
};

const data = require('./views/index.handlebars');


const mailOptions = {
  from: "smir.mishra1551@gmail.com",
  to: "sam2369@my.londonmet.ac.uk",
  subject: "trial message",
  text: "random message",
  html: data,
};
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASSWORD,
  },
});

transporter.verify(function (error, success) {
  if (error) {
    console.log(error);
  } else {
    console.log("Server is ready to take our messages");
  }
});

transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    return console.log(error);
  } else {
    console.log("Message sent: %s", info.messageId);
  }
});
