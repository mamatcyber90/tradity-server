(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;
var buscomponent = require('./buscomponent.js');

function DelayedQueriesDB () {
	this.queries = {};
	
	this.neededStocks = {};
	this.queryTypes = ['stock-buy', 'dquery-remove'];
};
util.inherits(DelayedQueriesDB, buscomponent.BusComponent);

DelayedQueriesDB.prototype.onBusConnect = function() {
	this.on('stock-update', function(ev) {
		if (this.neededStocks['s-'+ev.stockid]) {
			_.each(this.neededStocks['s-'+ev.stockid], _.bind(function(entryid) {
				this.checkAndExecute(this.queries[entryid]);
			}, this));
		}
	});
	
	this.loadDelayedQueries();
};

DelayedQueriesDB.prototype.getNeededStocks = buscomponent.provide('neededStocksDQ', ['reply'], function(cb) {
	var neededIDs = _.chain(this.neededStocks).keys().map(function(id) {
		return id.substr(2);
	}).value();
	
	cb(neededIDs);
	return neededIDs;
});

DelayedQueriesDB.prototype.checkAndExecute = function(query) {
	query.check(_.bind(function(condmatch) {
		if (!condmatch)
			return;
		this.executeQuery(query);
	}, this));
};

DelayedQueriesDB.prototype.loadDelayedQueries = function() {
	this.query('SELECT * FROM dqueries', [], function(r) {
		_.each(r, _.bind(function(res) {
			res.query = JSON.parse(res.query);
			res.userinfo = JSON.parse(res.userinfo);
			res.accessinfo = Access.fromJSON(res.accessinfo);
			this.addQuery(res);
		},this));
	});
};

DelayedQueriesDB.prototype.listDelayQueries = buscomponent.provideQT('client-dquery-list', function(query, ctx, cb) {
	cb('dquery-list-success', {
		'results': (_.chain(this.queries).values()
			.filter(function(q) { return q.userinfo.id == ctx.user.id; })
			.map(function(q) { return _.omit(q, 'userinfo', 'accessinfo'); })
			.value())
	});
});

DelayedQueriesDB.prototype.removeQueryUser = buscomponent.provideQT('client-dquery-remove', function(query, ctx, cb) {
	var queryid = query.queryid;
	if (this.queries[queryid] && this.queries[queryid].userinfo.id == ctx.user.id) {
		this.removeQuery(this.queries[queryid]);
		cb('dquery-remove-success');
	} else {
		cb('dquery-remove-notfound');
	}
});

DelayedQueriesDB.prototype.addDelayedQuery = buscomponent.provideQT('client-dquery', function(query, ctx, cb) {
	cb = cb || function() {};
	
	var qstr = null;
	try {
		this.parseCondition(query.condition);
		qstr = JSON.stringify(query.query);
	} catch (e) {
		this.emit('error', e);
		return cb('format-error');
	}
	
	if (this.queryTypes.indexOf(query.query.type) == -1)
		cb('unknown-query-type');
	
	this.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
		[query.condition, qstr, JSON.stringify(ctx.user), ctx.access.toJSON()], function(r) {
		query.queryid = r.insertId;
		query.userinfo = ctx.user;
		query.accessinfo = ctx.access;
		cb('dquery-success', {'queryid': query.queryid});
		this.addQuery(query);
	});
});

DelayedQueriesDB.prototype.addQuery = function(query) {
	assert.ok(query);

	var cond = this.parseCondition(query.condition);
	query.check = cond.check;
	query.neededStocks = cond.neededStocks;
	var entryid = query.queryid + '';
	assert.ok(!this.queries[entryid]);
	this.queries[entryid] = query;
	_.each(query.neededStocks, _.bind(this.addNeededStock,this,query.queryid));
	this.checkAndExecute(query);
};

DelayedQueriesDB.prototype.addNeededStock = function(queryid, stock) {
	if (this.neededStocks['s-'+stock]) {
		assert.equal(_.indexOf(this.neededStocks['s-'+stock], queryid), -1);
		this.neededStocks['s-'+stock].push(queryid);
	} else {
		this.neededStocks['s-'+stock] = [queryid];
	}
};

DelayedQueriesDB.prototype.parseCondition = function(str) {
	var clauses = str.split('∧');
	var cchecks = [];
	var stocks = [];
	_.each(clauses, _.bind(function(cl) {
		cl = cl.trim();
		var terms = cl.split(/[<>]/);
		if (terms.length != 2)
			throw new Error('condition clause must contain exactly one < or > expression');
		var lt = cl.indexOf('<') != -1;
		var lhs = terms[0].trim();
		var rhs = terms[1].trim();
		var variable = lhs.split(/::/);
		var value = parseFloat(rhs);
		switch (variable[0]) {
			case 'time':
				cchecks.push(function(cb) {
					var t = new Date().getTime()/1000;
					cb(lt ? t < value : t > value);
				});
				break;
			case 'stock':
				if (variable.length != 3)
					throw new Error('expecting level 3 nesting for stock variable');
				var stockid = variable[1];
				var fieldname = variable[2];
				if (_.indexOf(stocks, stockid) == -1)
					stocks.push(stockid);
				switch(fieldname) {
					case 'exchange-open':
						cchecks.push(_.bind(function(cb) {
							this.query('SELECT exchange FROM stocks WHERE stockid = ?', [stockid], function(r) {
								if (r.length == 0)
									return cb(false);
								
								this.getServerConfig(function(cfg) {
									assert.ok(cfg);
									
									this.request({name: 'stockExchangeIsOpen', sxname: r[0].exchange, cfg: cfg}, function(isOpen) {
										return cb(lt ? isOpen < value : isOpen > value);
									});
								});
							});
						}, this));
						break;
					default:
						if (!/^\w+$/.test(fieldname))
							throw new Error('bad fieldname');
						cchecks.push(_.bind(function(cb) {
							this.query('SELECT ' + fieldname + ' FROM stocks WHERE stockid = ?', [stockid], function(r) {
								cb(r.length > 0 && (lt ? r[0][fieldname] < value : r[0][fieldname] > value));
							});
						}, this));
						break;
				}
				break;
			default:
				throw new Error('unknown variable type');
		}
	}, this));
	return {check: function(cb) {
		var result = true;
		var count = 0;
		_.each(cchecks, function(check) {
			check(function(res) {
				result = result && res;
				if (++count == cchecks.length)
					cb(result);
			});
		});
	}, neededStocks: stocks};
};

DelayedQueriesDB.prototype.executeQuery = function(query) {
	query.query.__is_delayed__ = true;
	this.request({
			name: 'client-' + query.query.type,
			query: query.query,
			ctx: new qctx.QContext({user: query.userinfo, access: query.accessinfo})
		}, function(code)
	{
		var json = query.query.dquerydata || {};
		json.result = code;
		if (!query.query.retainUntilCode || query.query.retainUntilCode == code) {
			this.feed({'type': 'dquery-exec', 'targetid':null, 'srcuser': query.userinfo.id, 'json': json, 'noFollowers': true});
			this.removeQuery(query);
		}
	});
};

DelayedQueriesDB.prototype.removeQuery = function(query) {
	this.query('DELETE FROM dqueries WHERE queryid = ?', [query.queryid], function() {
		delete this.queries[query.queryid];
		_.each(query.neededStocks, _.bind(function(stock) {
			this.neededStocks['s-'+stock] = _.without(this.neededStocks['s-'+stock], query.queryid);
			if (this.neededStocks['s-'+stock].length == 0)
				delete this.neededStocks['s-'+stock];
		}, this));
	});
};

DelayedQueriesDB.prototype.resetUser = buscomponent.provide('dqueriesResetUser', ['ctx', 'reply'], function(ctx, cb) {
	var toBeDeleted = [];
	for (var queryid in this.queries) {
		var q = this.queries[queryid];
		if (q.userinfo.id == ctx.user.id || (q.query.leader == ctx.user.id))
			toBeDeleted.push(q);
	}
	
	for (var i = 0; i < toBeDeleted.length; ++i)
		this.removeQuery(toBeDeleted[i]);
	
	cb();
});

exports.DelayedQueriesDB = DelayedQueriesDB;
})();

