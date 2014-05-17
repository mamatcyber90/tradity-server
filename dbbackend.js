(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function Database () {
	this.dbmod = null;
	this.connectionPool = null;
	this.openQueries = 0;
	this.isShuttingDown = false;
}

util.inherits(Database, buscomponent.BusComponent);

Database.prototype._init = function(cb) {
	this.getServerConfig(function(cfg) {
		this.dbmod = cfg['dbmod'] || require('mysql');
		this.connectionPool = this.dbmod.createPool(cfg['db']);
		this.inited = true;
		this.openQueries = 0;
		
		/*
		 * Note: We don't set isShuttingDown = true here.
		 * This happens so we can actually resurrect the database connection
		 * during the shutdown process, so other components can complete
		 * any work in progress.
		 */
		
		cb();
	});
};

Database.prototype.shutdown = buscomponent.listener('masterShutdown', function() {
	this.isShuttingDown = true;
	
	if (this.connectionPool && this.openQueries == 0) {
		this.connectionPool.end();
		this.connectionPool = null;
		this.inited = false;
	}
});

Database.prototype._query = buscomponent.needsInit(function(query, args, cb) {
	this._getConnection(function(err, connection) {
		if (err)
			return cb(err, null);
		connection.query(query, args, function() {
			connection.release();
			cb.apply(this, arguments);
		});
	});
});

Database.prototype._getConnection = buscomponent.needsInit(function(cb) {
	assert.ok (this.connectionPool);
	
	this.openQueries++;
	
	var db = this;
	this.connectionPool.getConnection(function(err, conn) {
		if (conn === null)
			return cb(err, null);
		
		cb(err, {
			query: _.bind(conn.query, conn),
			release: function() {
				db.openQueries--;
				
				if (db.openQueries == 0 && db.isShuttingDown)
					db.shutdown();
				
				return conn.release();
			}
		});
	});
});

Database.prototype.escape = buscomponent.needsInit(function(str) {
	return this.dbmod.escape(str);
});

Database.prototype.timeQueryWrap = function(fn, connid, wrapCb) {
	wrapCb = _.bind(wrapCb, this);
	
	this.getServerConfig(function(cfg) {
		if (cfg && cfg.timeQueries) {
			wrapCb(_.bind(function(query, data, cb) {
				var tStart = new Date().getTime();
				
				fn(query, data, _.bind(function() {
					var tEnd = new Date().getTime();
					this.message('queryTiming', 'Query ' + connid + ' ' + query.substr(0, 60) + ' took ' + (tEnd - tStart) + ' ms');
					
					cb.apply(this, arguments);
				}, this));
			}, this));
		} else {
			wrapCb(_.bind(fn, this));
		}
	});
};

Database.prototype.query = buscomponent.provide('dbQuery', ['query', 'args', 'reply'], function(query, data, cb) {
	data = data || [];
	
	this.timeQueryWrap(_.bind(this._query, this), '*', _.bind(function(f) {
		f(query, data, this.queryCallback(cb, query, data));
	}, this));
});

Database.prototype.getConnection = buscomponent.provide('dbGetConnection', ['reply'], function(conncb) {
	this._getConnection(_.bind(function(err, cn) {
		if (err)
			this.emit('error', err);
			
		if (!this.dbconnid)
			this.dbconnid = 0;
		var connid = ++this.dbconnid;
		
		conncb({
			query: _.bind(function(q, data, cb) {
				data = data || [];
				this.timeQueryWrap(_.bind(cn.query, cn), connid, function(f) {
					f(q, data, this.queryCallback(cb, q, data));
				});
			}, this),
			release: _.bind(function() {
				cn.release();
			}, this)
		});
	}, this));
});

Database.prototype.queryCallback = function(cb, query, data) {
	return _.bind(function(err, res) {
		var datajson = JSON.stringify(data);
		
		if (err) {
			var querydesc = '<<' + query + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
			
			this.emit('error', query ? new Error(
				err + '\nCaused by ' + querydesc
			) : err);
		} else if (cb) {
			_.bind(cb, this)(res);
		}
	}, this);
};

exports.Database = Database;

})();
