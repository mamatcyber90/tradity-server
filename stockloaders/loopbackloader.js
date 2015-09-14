(function () { "use strict";

var Q = require('q');
var assert = require('assert');
var util = require('util');
var _ = require('lodash');
var config = require('../config.js');
var abstractloader = require('./abstractloader.js');

function LoopbackQuoteLoader (opt) {
	assert.ok(opt);
	assert.ok(opt.ctx);
	
	LoopbackQuoteLoader.super_.apply(this, opt);
	
	this.ctx = opt.ctx;
}
util.inherits(LoopbackQuoteLoader, abstractloader.AbstractLoader);

LoopbackQuoteLoader.prototype._makeQuoteRequestFetch = function(stocklist) {
	var self = this;
	
	return self.ctx.query('SELECT * FROM stocks WHERE stocktextid IN (' +
		_.map(stocklist, _.constant('?')).join(',') + ')', stocklist).then(function(results) {
		
		return _.map(results, function(record) {
			record.isin = record.stocktextid;
			record.symbol = record.isin;
			record.failure = null;
			record.currency_name = 'EUR';
			
			if (record.leader === null) {
				var factor = Math.exp((Math.random() - 0.5) * 0.1 * (Date.now()/1000.0 - record.lastchecktime) / 86400.0);
				record.ask *= factor / 10000.0;
				record.bid *= factor / 10000.0;
			}
			
			record.last = (record.ask + record.bid)/2.0;
			record.lastTradePrice = record.last;
			
			return self._handleRecord(record, false);
		});
	});
};

exports.QuoteLoader = LoopbackQuoteLoader;

})();