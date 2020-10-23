const _ = require('lodash');
const util = require('util');
const Imap = require('imap');
const { MailParser } = require('mailparser');
const { EventEmitter } = require('events');
const debug = require('debug')('imapnotify:notify');
const imapDebug = require('debug')('imapnotify:imap');

function ImapNotify(opts) {
  const acct = {
    user: opts.user || opts.username,
    host: opts.host || 'localhost',
    port: opts.port || 143,
    tls: opts.tls || false,
    tlsOptions: opts.tlsOptions || {},
    debug: opts.debug || imapDebug,
    autotls: 'always',
    keepalive: {
      interval: 10000,
      idleInterval: 300000, // 5 mins
      forceNoop: true
    }
  };
  
  this.filter=opts.filter||null;
  
  this.markSeen=opts.markSeen||false;

  const { box } = opts;

  if (!opts.password) {
    acct.xoauth2 = opts.xoauth2;
  } else {
    acct.password = opts.password;
  }

  const self = this;
  this.imap = new Imap(acct);
  this.imap.connect();
  this.connected = false;
  this.imap.on('error', err => {
    debug('[notify.imap.on.error] %o', err);
    self.emit('error', err);
  });

  this.imap.on('ready', () => {
    debug('[notify.imap.on.ready] triggered');
    self.connected = true;
    self.imap.openBox(box, false, err => {
      debug('[self.imap.openBox(box) callback()');
      if (err) {
        debug('[self.imap.openBox(box).err]: %o', err);
        self.emit('error', err);
      } else {
        debug('[self.imap.openBox(box).success]');
        self.emit('success');
      }
    });
  });

  this.imap.on('mail', () => {
    debug('[notify.imap.on.mail] triggered');
    fetchNewMsgs.call(self);
  });

  this.imap.on('end', () => {
    debug('[notify.imap.on.end] triggered');
    self.connected = false;
    self.emit('end');
  });

  this.imap.on('close', err => {
    debug('[notify.imap.on.close] triggered');
    self.connected = false;
    if (err) {
      debug('[notify.imap.on.close] called with ERROR: %o', err);
      self.emit('error', err);
    }

    self.emit('close');
  });
}

function fetchNewMsgs(msgCount = 1) {
  debug('fetchNewMsgs called');
  const self = this;
  var day;
  if(this.filter==null){
    day = new Date();
    day.setUTCDate(day.getUTCDate() - 2);
    day.setUTCHours(23);
    day.setUTCMinutes(59);
  }

  // We do not search for only UNSEEN since this could return 1000's of messages
  // we do the search since yesterday so we can catch messages sent on 11:59:59
  // but perform the search at 12:00:00
  this.imap.search(this.filter||['UNSEEN', ['SINCE', day]], (err, uids) => {
    if (err) {
      debug('[notify.imap.search] returned with error: %o', err);
      self.emit('error', err);
      return self;
    }

    const { length } = uids;
    const uidsToFetch = _.chain(uids)
      .slice(length - msgCount, length)
      .value();

    if (uidsToFetch && uidsToFetch.length > 0) {
      debug('About to fetch: %s', JSON.stringify(uidsToFetch));
      fetch.call(self, uidsToFetch);
    } else {
      debug('No messages to fetch');
    }

    return self;
  });
}

function fetch(uids) {
  debug('[fetch] with uids: %o', uids);

  const opts = {
    markSeen: this.markSeen,
    bodies: ''
  };

  const fetcher = this.imap.fetch(uids, opts);
  const self = this;

  fetcher.on('message', msg => {
    debug('[fetcher.on.message] triggered. Creating new MailParser() instance');
    const parser = new MailParser();
    const mail = {};
    mail.headers = {};
    mail.attachment = [];
    parser.on('headers', headers => {
      debug('[parser.on.headers] triggered');
      for (const [k, v] of headers) {
        mail.headers[k] = v;
      }
    });
    parser.on('data', data => {
      debug('[parser.on.data] triggered');
      if (data.type === 'attachment') {
        debug('Data is attachment');
        mail.attachment.push(data);
        data.content.on('readable', () => data.content.read());
        data.content.on('end', () => data.release());
      } else {
        debug('Data is mail body text');
        mail.text = data;
      }
    });

    parser.on('end', () => {
      debug('[parser.on.end] triggered. Emitting fetcher.end && notify.email');
      fetcher.emit('end');
      self.emit('mail', mail);
    });

    msg.on('body', stream => stream.pipe(parser));
    msg.on('attributes', attribs => {
      mail.attributes = attribs;
    });
    msg.on('end', () => {
      debug('[msg.on.end] triggered. Emitting parser.end');
      parser.end();
    });
  });

  fetcher.once('error', err => {
    debug('fetcher.once.error. Err: %o', err);
    self.emit('error', err);
  });

  fetcher.once('end', () => {
    debug('[fetcher.once.end]');
    return;
  });
}

util.inherits(ImapNotify, EventEmitter);

module.exports = function(opts) {
  return new ImapNotify(opts);
};
