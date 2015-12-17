"use strict";

var _ = require('lodash');
var fs = require('fs');
var util = require('util');
var PSemaphore = require('promise-semaphore');
var ratelimit = require('promise-ratelimit');
var buscomponent = require('./stbuscomponent.js');
var debug = require('debug')('sotrade:error');
const promiseUtil = require('./lib/promise-util.js');

/**
 * Provides methods for handling, logging, and notifying about errors.
 * 
 * @public
 * @module errorhandler
 */

/**
 * Main object of the {@link module:errorhandler} module
 * 
 * @public
 * @constructor module:errorhandler~ErrorHandler
 * @augments module:stbuscomponent~STBusComponent
 */
class ErrorHandler extends buscomponent.BusComponent {
  constructor() {
    super();
  
    this.sem = new PSemaphore();
    this.throttle = ratelimit(10000);
  }
}

/**
 * Listener for <code>error</code> events.
 * 
 * This logs the error and sends, if possible, an e-mail
 * to notify about the error.
 * The exact behaviour, such as the e-mail recipient, can be set
 * in the server configuration.
 * 
 * @function module:errorhandler~ErrorHandler#err
 */
ErrorHandler.prototype.err = buscomponent.listener('error', function(e, noemail) {
  if (!e)
    return this.err(new Error('Error without Error object caught -- abort'), true);
  
  debug('Error', e);
  
  var cfg, longErrorText;
  var catchstack = new Error().stack; // current stack
  
  this.getServerConfig().catch(e2 => {
    console.error('Could not get server config due to', e2);
    return null;
  }).then(cfg_ => {
    cfg = cfg_;
    
    return this.throttle();
  }).then(() => {
    return this.sem.add(() => {
      return Promise.resolve().then(() => {
        noemail = noemail || false;
        
        longErrorText = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
        if (e.stack)
          longErrorText += e.stack + '\n';
        else // assume e is not actually an Error instance
          longErrorText += util.inspect(e) + '\n';
        
        // indicating current stack may be helpful
        longErrorText += catchstack + '\n';
        
        if (this.bus) {
          longErrorText += 'Bus: ' + this.bus.id + '\n';
        
          if (e.nonexistentType || e.name.match(/^Assertion/i))
            longErrorText += '\n' + JSON.stringify(this.bus.busGraph.json()) + '\n';
        }
        
        if (!process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS)
          console.error(longErrorText);
        
        if (cfg && cfg.errorLogFile)
          return promiseUtil.ncall(fs.appendFile)(cfg.errorLogFile.replace(/\{\$pid\}/g, process.pid), longErrorText);
      }).then(() => {
        if (cfg && cfg.mail) {
          var opt = _.clone(cfg.mail['errorBase']);
          opt.text = longErrorText;
          return this.request({name: 'sendMail', mailtype: 'error', opt: opt});
        } else {
          console.warn('Could not send error mail due to missing config!');
        }
      });
    });
  }).catch(e2 => {
    console.error('Error while handling other error:\n', e2, 'during handling of\n', e);
    process.exit(64);
  });
});

exports.ErrorHandler = ErrorHandler;
