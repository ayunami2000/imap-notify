const moment = require('moment');
const _ = require('lodash');
const util = require('util');
const Imap = require('imap');
const { MailParser } = require('mailparser');
const { EventEmitter } = require('events');

function ImapNotify(opts) {
  const acct = {
    user: opts.user || opts.username,
    host: opts.host || 'localhost',
    port: opts.port || 143,
    tls: opts.tls || false,
    tlsOptions: opts.tlsOptions || {},
    debug: opts.debug || function() {},
    autotls: 'always',
    keepalive: {
      interval: 10000,
      idleInterval: 300000, // 5 mins
      forceNoop: true
    }
  };

  const { box } = opts;

  if (!opts.password) {
    acct.xoauth2 = opts.xoauth2;
  } else {
    acct.password = opts.password;
  }

  this.imap = new Imap(acct);

  this.imap.connect();

  this.connected = false;

  this.imap.on('error', err => {
    this.emit('error', err);
  });

  this.imap.on('ready', () => {
    this.connected = true;
    this.imap.openBox(box, false, err => {
      if (err) {
        this.emit('error', err);
      } else {
        this.emit('success');
      }
    });
  });

  this.imap.on('mail', fetchNewMsgs.bind(this));

  this.imap.on('end', () => {
    this.connected = false;
    this.emit('end');
  });

  this.imap.on('close', err => {
    this.connected = false;
    if (err) {
      this.emit('error', err);
    }

    this.emit('close');
  });
}

function fetchNewMsgs(msgCount) {
  const yesterday = moment()
    .subtract(2, 'days')
    .toDate();
  // let length, uidsToFetch;

  // We do not search for only UNSEEN since this could return 1000's of messages
  // we do the search since yesterday so we can catch messages sent on 11:59:59
  // but perform the search at 12:00:00
  this.imap.search(['UNSEEN', ['SINCE', yesterday]], (err, uids) => {
    if (err) {
      this.emit('error', err);
      return this;
    }

    const { length } = uids;
    const uidsToFetch = _.chain(uids)
      //      .sortByAll()
      .slice(length - msgCount, length)
      .value();

    if (uidsToFetch && uidsToFetch.length > 0) {
      fetch.call(this, uidsToFetch);
    }

    return this;
  });
}

function fetch(uids) {
  const opts = {
      markSeen: false,
      bodies: ''
    },
    fetcher = this.imap.fetch(uids, opts);

  fetcher.on('message', msg => {
    const parser = new MailParser();
    let attributes;

    msg.once('attributes', attributesHandler);
    msg.on('body', messageBody);
    msg.on('end', messageEnd);

    parser.on('end', parserEnd.bind(this));

    function messageBody(stream) {
      let buffer = '';

      stream.on('data', data);
      stream.once('end', end);

      function data(chunk) {
        buffer += chunk;
      }

      function end() {
        parser.write(buffer);
      }
    }

    function attributesHandler(attrs) {
      attributes = attrs;
    }

    function parserEnd(mailObj) {
      // inject attributes into mail object
      mailObj.attributes = attributes;

      this.emit('mail', mailObj);
    }

    function messageEnd() {
      parser.end();
    }
  });

  fetcher.once('error', err => {
    this.emit('error', err);
  });

  fetcher.once('end', () => {
    return;
  });
}

util.inherits(ImapNotify, EventEmitter);

module.exports = function(opts) {
  return new ImapNotify(opts);
};
