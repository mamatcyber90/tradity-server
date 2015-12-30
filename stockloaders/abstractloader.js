"use strict";

const _ = require('lodash');
const util = require('util');
const request = require('request');
const debug = require('debug')('sotrade:stockloader');
const promiseUtil = require('../lib/promise-util.js');

const MAXLEN_DEFAULT = 196;
const CACHE_TIME_DEFAULT = 25000;

class AbstractLoader extends promiseUtil.EventEmitter {
  constructor(opt) {
    super();
    opt = opt || {};
    
    this.setMaxListeners(0);
    this.cacheTime = typeof opt.cacheTime == 'undefined' ? CACHE_TIME_DEFAULT : opt.cacheTime;
    this.maxlen = typeof opt.maxlen == 'undefined' ? MAXLEN_DEFAULT : opt.maxlen;
    this.requestRetries = typeof opt.requestRetries == 'undefined' ? 2 : opt.requestRetries;
    this.cache = {};
  }

  _handleRecord(record, cached) {
    if (!cached && record.failure == null) {
      if (!record.fetchTime)
        record.fetchTime = Date.now();

      this.cache['s-' + record.symbol] = record;
    }
    
    this.emit('record', record);
    
    return record;
  };

  _makeQuoteRequest(stocklist) {
    let cachedResults = [];
    stocklist = stocklist.filter(stockid => {
      const cv = this.cache['s-' + stockid];
      if (cv) {
        if (cv.fetchTime > Date.now() - this.cacheTime) {
          cachedResults.push(this._handleRecord(cv, true));
          return false;
        } else {
          delete this.cache['s-' + stockid];
        }
      }
      
      return true;
    });
    
    if (stocklist.length == 0) // everything was cached
      return Promise.resolve(cachedResults);
    
    // split stocklist into groups of maximum length maxlen
    // and flatten the resulting chunked array of records
    const chunkedStocklist = _.chunk(stocklist, this.maxlen);
    
    debug('Fetching stock list', stocklist.length, chunkedStocklist.length + ' chunks');
    
    return Promise.all(chunkedStocklist.map(chunk => {
      return this._makeQuoteRequestFetch(chunk);
    })).then(recordListChunks => {
      const fetchedRecordList = _.flatten(recordListChunks);
      
      const receivedStocks = [];
      fetchedRecordList.forEach(record => {
        if (record.isin) receivedStocks.push(record.isin);
        if (record.wkn)  receivedStocks.push(record.wkn);
      });
      
      const notReceivedStocks = _.difference(stocklist, receivedStocks);
      notReceivedStocks.forEach(failedName => {
        return this._handleRecord({failure: failedName}, false);
      });
      
      return fetchedRecordList.concat(cachedResults).filter(record => !record.failure);
    });
  }

  loadQuotesList(stocklist, filter) {
    filter = filter || (() => true);
    
    return Promise.resolve().then(() => {
      return this._makeQuoteRequest(stocklist);
    }).then(records => records.filter(filter));
  }

  request(url, attemptsLeft) {
    if (typeof attemptsLeft == 'undefined')
      attemptsLeft = this.requestRetries;
    
    const requestDeferred = Promise.defer();
    request({
      url: url,
      headers: {
        'User-Agent': this.userAgent
      }
    }, (err, res, body) => {
      if (err)
        return requestDeferred.reject(err);
      
      if (res.statusCode >= 500 && res.statusCode <= 599 && attemptsLeft > 0)
        return promiseUtil.delay(750).then(() => this.request(url, attemptsLeft - 1));
      
      if (res.statusCode != 200)
        return requestDeferred.reject(new Error('Stock loader error: URL ' + url + ' returned status code ' + res.statusCode));
      
      debug('Loaded', url, res.statusCode);
      
      requestDeferred.resolve(body);
    });
    
    return requestDeferred.promise;
  }
}

exports.AbstractLoader = AbstractLoader;
