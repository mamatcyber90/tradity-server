(function () { "use strict";

var Access = require('./access.js').Access;
var util = require('util');
var assert = require('assert');
var weak = require('weak');
var buscomponent = require('./stbuscomponent.js');
var _ = require('lodash');

/**
 * Provides the {@link module:qctx~QContext} object.
 * 
 * @public
 * @module qctx
 */

/**
 * Represents the context in which server code gets executed.
 * 
 * @property {?object} user  The current user’s object
 * @property {module:access~Access} access  The current privilege level
 * @property {object} properties  Various high-level properties
 * @property {function[]} debugHandlers  Debug functions to be called when debugging is enabled
 * @property {function[]} errorHandlers  Handlers in case of failures during code execution
 *                                       under this context.
 * @property {function[]} callbackFilters  Filters that are applied to bus request callbacks
 * @property {module:qctx~QContext[]} childContexts  A list of weak references to child QContexts
 *                                                   (e.g. for debugging resource usage)
 * @property {object[]} openConnections  A list of open database connections.
 * @property {object[]} tableLocks  A list of held table locks.
 * @property {int} queryCount  The number of executed single database queries.
 * @property {int} incompleteQueryCount  The number of not-yet-completed single database queries.
 * @property {string} creationStack  A stack trace of this query context’s construction call
 * @property {int} creationTime  Millisecond unix timestmap of this query context’s construction call
 * 
 * @public
 * @constructor module:qctx~QContext
 * @augments module:stbuscomponent~STBusComponent
 */
function QContext(obj) {
	var self = this;
	
	QContext.super_.apply(self);
	
	obj = obj || {};
	self.user = obj.user || null;
	self.access = obj.access || new Access();
	self.properties = {};
	self.debugHandlers = [];
	self.errorHandlers = [];
	
	self.isQContext = true;
	self.childContexts = [];
	self.tableLocks = [];
	self.openConnections = [];
	self.queryCount = 0;
	self.incompleteQueryCount = 0;
	self.creationStack = getStack();
	self.creationTime = Date.now();
	
	self.callbackFilters.push(function(callback) {
		return self.errorWrap(callback);
	});
	
	var parentQCtx = null;
	
	if (obj.parentComponent) {
		if (obj.isQContext)
			parentQCtx = obj.parentComponent;
		
		self.setBusFromParent(obj.parentComponent);
	}
	
	if (!parentQCtx && !obj.isMasterQCTX)
		parentQCtx = QContext.getMasterQueryContext();
	
	function ondestroy(_ctx) {
		if (_ctx.tableLocks.length > 0 || _ctx.openConnections.length > 0) {
			console.log('QUERY CONTEXT DESTROYED WITH OPEN CONNECTIONS/TABLE LOCKS');
			console.log(JSON.stringify(_ctx));
			
			try {
				_ctx.emitError(new Error('Query context cannot be destroyed with held resources'));
			} catch (e) { console.log(e); }
			
			setTimeout(function() {
				process.exit(122);
			}, 1500);
		}
	}
	
	if (parentQCtx)
		parentQCtx.childContexts.push(weak(this, ondestroy));
	
	self.addProperty({name: 'debugEnabled', value: false, access: 'server'});
};

util.inherits(QContext, buscomponent.BusComponent);

QContext.masterQueryContext = null;

QContext.getMasterQueryContext = function() {
	if (QContext.masterQueryContext)
		return QContext.masterQueryContext;
	
	QContext.masterQueryContext = new QContext({isMasterQCTX: true});
};

/**
 * Return a copy of this QContext.
 * 
 * @return {module:qctx~QContext}  A shallow copy of this QContext.
 * @function module:qctx~QContext#clone
 */
QContext.prototype.clone = function() {
	var c = new QContext({
		user: this.user,
		access: this.access.clone(),
		parentComponent: this
	});
	
	c.properties = _.clone(this.properties);
	c.debugHandlers = this.debugHandlers.slice();
	c.errorHandlers = this.errorHandlers.slice();
	
	return c;
};

/**
 * List all child QContexts of this query context.
 * Garbage collected QContexts are automatically excluded.
 * 
 * @return {module:qctx~QContext[]}  A list of QContexts.
 * @function module:qctx~QContext#getChildContexts
 */
QContext.prototype.getChildContexts = function() {
	var rv = [];
	
	for (var i = 0; i < this.childContexts.length; ++i) {
		var r = weak.get(this.childContexts[i]);
		if (weak.isDead(this.childContexts[i]))
			delete this.childContexts[i];
		rv.push(r);
	}
	
	// remove deleted indices
	this.childContexts = _.compact(this.childContexts);
	
	return rv;
};

/**
 * Wrap a callback for exception handling by this callback.
 * 
 * @param {?function} callback  A generic function to wrap
 * 
 * @return {function}  A callback of the same signature.
 * @function module:qctx~QContext#errorWrap
 */
QContext.prototype.errorWrap = function(callback) {
	var self = this;
	
	callback = callback || function() {};
	
	return function() {
		try {
			return callback.apply(self, arguments);
		} catch (e) {
			self.emitError(e);
		}
	};
};

QContext.prototype.onBusConnect = function() {
	var self = this;
	
	self.request({name: 'get-readability-mode'}, function(reply) {
		assert.ok(reply.readonly === true || reply.readonly === false);
		
		if (!self.hasProperty('readonly')) {
			self.addProperty({
				name: 'readonly',
				value: reply.readonly
			});
		}
	});
};

QContext.prototype.changeReadabilityMode = buscomponent.listener('change-readability-mode', function(event) {
	if (this.hasProperty('readonly'))
		this.setProperty('readonly', event.readonly);
});

/**
 * Serialize this QContext into a raw JS object.
 * 
 * @return {object}  An object to be passed to {@link module:qctx~fromJSON}
 * @function module:qctx~QContext#toJSON
 */
QContext.prototype.toJSON = function() {
	return { user: this.user, access: this.access.toJSON(), properties: this.properties };
};

/**
 * Deserialize this JS object into a new QContext.
 * 
 * @param {object} j  A serialized version as returned by {@link module:qctx~QContext#toJSON}.
 * @param {module:buscomponent~BusComponent} parentComponent  A parent component whose bus 
 *                                                            should be connected to.
 * 
 * @return {object}  A freshly created {@link module:qctx~QContext}.
 * @function module:qctx~QContext#errorWrap
 */
exports.fromJSON =
QContext.fromJSON = function(j, parentComponent) {
	var ctx = new QContext({parentComponent: parentComponent});
	if (!j)
		return ctx;
	
	ctx.user = j.user || null;
	ctx.access = Access.fromJSON(j.access);
	ctx.properties = j.properties || {};
	
	return ctx;
};

/**
 * Adds a new property to the list of context properties.
 * 
 * @param {object} propInfo
 * @param {string} propInfo.name  The name of this property
 * @param {module:access~Access} propInfo.access  Access restrictions for
 *                                                changing this property
 * @param propInfo.value  The default/initial value for this property
 * 
 * @function module:qctx~QContext#addProperty
 */
QContext.prototype.addProperty = function(propInfo) {
	this.properties[propInfo.name] = propInfo;
};

/**
 * Fetches a property value.
 * 
 * @param {string} name  The property name.
 * @return  The property value.
 * 
 * @function module:qctx~QContext#getProperty
 */
QContext.prototype.getProperty = function(name) {
	return this.properties[name].value;
};

/**
 * Returns whether a given property value exists.
 * 
 * @param {string} name  The property name.
 * @return  True iff such a property exists.
 * 
 * @function module:qctx~QContext#hasProperty
 */
QContext.prototype.hasProperty = function(name) {
	return this.properties[name] ? true : false;
};

/**
 * Sets a property value.
 * 
 * @param {string} name  The property name.
 * @param value  The new property value.
 * @param {?boolean} hasAccess  If true, pass all access checks.
 * 
 * @function module:qctx~QContext#setProperty
 */
QContext.prototype.setProperty = function(name, value, hasAccess) {
	if (!this.hasProperty(name))
		throw new Error('Property ' + name + ' not defined yet');
	
	var requiredAccess = this.properties[name].access;
	if (!requiredAccess) {
		hasAccess = true;
	} else if (typeof requiredAccess == 'string') {
		hasAccess = hasAccess || this.access.has(requiredAccess);
	} else if (typeof requiredAccess == 'function') {
		hasAccess = hasAccess || requiredAccess(this);
	} else {
		throw new Error('Unknown access restriction ' + JSON.stringify(requiredAccess));
	}
	
	if (hasAccess)
		this.properties[name].value = value;
	else
		throw new Error('Access for changing property ' + name + ' not granted ' + requiredAccess);
};

/**
 * Shorthand method for pushing feed entries.
 * See {@link busreq~feed}.
 * 
 * @function module:qctx~QContext#feed
 */
QContext.prototype.feed = function(data, onEventId) { 
	return this.request({name: 'feed', data: data, ctx: this}, onEventId || function() {});
};

/**
 * Shorthand method for executing database queries.
 * See {@link busreq~dbQuery}.
 * 
 * @function module:qctx~QContext#query
 */
QContext.prototype.query = function(query, args, cb) {
	cb = cb || function() {};
	
	var self = this;
	self.debug('Executing query [unbound]', query, args);
	self.incompleteQueryCount++;
	
	return this.request({name: 'dbQuery', query: query, args: args}, function() {
		self.incompleteQueryCount--;
		self.queryCount++;
		
		cb.apply(this, arguments);
	}); 
};

/**
 * Shorthand method for fetching a single connection for database queries.
 * Mostly, see {@link busreq~dbGetConnection}.
 * 
 * @param {boolean} [readonly=false]  Whether the connection requires no write access.
 * @param {function} restart  Callback that will be invoked when the current transaction
 *                            needs restarting.
 * @param {function} cb  Callback that will be called with the new connection and 
 *                       commit() and rollback() shortcuts (both releasing the connection).
 * 
 * @function module:qctx~QContext#getConnection
 */
QContext.prototype.getConnection = function(readonly, restart, cb) {
	var self = this;
	
	if (typeof readonly == 'function') {
		cb = readonly;
		readonly = false;
	}
	
	var oci = self.openConnections.push([{readonly: readonly, time: Date.now(), stack: getStack()}]) - 1;
	
	self.request({readonly: readonly, restart: restart, name: 'dbGetConnection'}, function(conn) {
		var postTransaction = function(doRelease, ecb) {
			delete self.openConnections[oci];
			if (_.compact(self.openConnections) == [])
				self.openConnections = [];
			
			if (typeof doRelease == 'function') {
				ecb = doRelease;
				doRelease = true;
			}
			
			if (typeof doRelease == 'undefined')
				doRelease = true;
			
			ecb = ecb || function() {};
			
			if (doRelease)
				conn.release();
			return ecb();
		};
		
		var oldrestart = restart;
		restart = function() {
			return postTransaction(oldrestart);
		};
		
		/* return wrapper object for better debugging, no semantic change */
		var conn_ = {
			release: _.bind(conn.release, conn),
			query: function(query, args, cb) {
				self.debug('Executing query [bound]', query, args);
				conn.query(query, args, self.errorWrap(cb));
			}
		};
		
		/* convenience functions for rollback and commit with implicit release */
		var commit = function(doRelease, ecb) {
			conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { postTransaction(doRelease, ecb); });
		};
		
		var rollback = function(doRelease, ecb) {
			conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;', [], function() { postTransaction(doRelease, ecb); });
		};
		
		cb(conn_, commit, rollback);
	}); 
};

/**
 * Fetch a single connection and prepare a transaction on it,
 * optionally locking tables.
 * 
 * @param {boolean} [readonly=false]  Whether the transaction requires no write access.
 * @param {object} [tablelocks={}]  An map of <code>table-name -> 'r' or 'w'</code> indicating 
 *                                  which tables to lock. The dictionary values can also be
 *                                  objects with the properties <code>mode, alias</code>,
 *                                  or you can use an array with a <code>name</code> property.
 * @param {function} [restart=true]  A callback that will be invoked when the transaction needs
 *                                   restarting, e.g. in case of database deadlocks. Use
 *                                   <code>true</code> to just rollback and call the startTransaction
 *                                   callback again.
 * @param {function} cb  Callback that will be called with the new connection and 
 *                       commit() and rollback() shortcuts (both releasing the connection).
 * 
 * @function module:qctx~QContext#startTransaction
 */
QContext.prototype.startTransaction = function(readonly, tablelocks, restart, cb) {
	var self = this, args = arguments;
	
	// argument shifting -- often, readonly and/or restart will not be given
	if (typeof readonly !== 'boolean') {
		cb = restart;
		restart = tablelocks;
		tablelocks = readonly;
		readonly = false;
	}
	
	if (typeof tablelocks !== 'object') {
		cb = restart;
		restart = tablelocks;
		tablelocks = {};
	}
	
	if (!cb) {
		cb = restart;
		restart = function() {
			self.startTransaction.apply(self, args);
		};
	}
	
	var tli = null;
	var notifyTimer = null;
	
	if (tablelocks)
		tli = self.tableLocks.push([{locks: tablelocks, time: Date.now(), stack: getStack()}]) - 1;
	
	var cleanTLEntry = function() {
		if (tli === null)
			return;
		
		if (notifyTimer)
			clearTimeout(notifyTimer);
		
		notifyTimer = null;
		delete self.tableLocks[tli];
		if (_.compact(self.tableLocks) == [])
			self.tableLocks = [];
		
		tli = null;
	};
	
	notifyTimer = setTimeout(function() {
		if (tli === null)
			return;
		
		self.emitError(new Error('Transaction did not close within timeout: ' + JSON.stringify(self.tableLocks[tli])));
	}, 60000);
	
	assert.equal(typeof cb, 'function');
	
	tablelocks = tablelocks || {};
	assert.ok(restart);
	
	var oldrestart = restart;
	restart = function() {
		cleanTLEntry();
		return oldrestart.apply(this, arguments);
	};
	
	self.getConnection(readonly, restart, function(conn, commit, rollback) {
		var tables = _.keys(tablelocks);
		var init = 'SET autocommit = 0; ';
		
		if (tables.length == 0)
			init += 'START TRANSACTION ';
		else
			init += 'LOCK TABLES ';
		
		for (var i = 0; i < tables.length; ++i) {
			var name = tables[i];
			var mode = tablelocks[name].mode || tablelocks[name];
			var alias = tablelocks[name].alias;
			var tablename = tablelocks[name].name || name;
			
			mode = {'r': 'READ', 'w': 'WRITE'}[mode];
			assert.ok(mode);
			
			init += tablename + (alias ? ' AS ' + alias : '') + ' ' + mode;
			
			if (i < tables.length - 1)
				init +=  ', ';
		}
		
		init += ';';
		
		conn.query(init, [], function() {
			cb(conn, function() {
				cleanTLEntry();
				return commit.apply(this, arguments);
			}, function() {
				cleanTLEntry();
				return rollback.apply(this, arguments);
			});
		});
	});
};

/**
 * If debugging is enabled, pass the arguments of this method to the debug handlers.
 * 
 * @function module:qctx~QContext#debug
 */
QContext.prototype.debug = function() {
	if (!this.hasProperty('debugEnabled') || !this.getProperty('debugEnabled'))
		return;
	
	for (var i = 0; i < this.debugHandlers.length; ++i)
		this.debugHandlers[i](Array.prototype.slice.call(arguments));
};

/**
 * Call context-specific error handlers and pass on to
 * {@link module:buscomponent~BusComponent#emitError}.
 * 
 * @function module:qctx~QContext#emitError
 */
QContext.prototype.emitError = function(e) {
	this.debug('Caught error', e);
	
	for (var i = 0; i < this.errorHandlers.length; ++i)
		this.errorHandlers[i](e);
	
	QContext.super_.prototype.emitError.call(this, e);
};

/**
 * Return some statistical information on this QContext,
 * including its properties.
 * 
 * @param {boolean} recurse  If true, include all <code>.childContexts</code>’ statistics.
 * 
 * @function module:qctx~QContext#getStatistics
 */
QContext.prototype.getStatistics = function(recurse) {
	assert.ok(recurse === true || recurse === false);
	
	var rv = {};
	
	for (var i in this.properties)
		rv[i] = this.properties[i].value;
	
	rv.tableLocks = _.compact(this.tableLocks);
	rv.openConnections = _.compact(this.openConnections);
	rv.queryCount = this.queryCount;
	rv.incompleteQueryCount = this.incompleteQueryCount;
	
	rv.creationTime = this.creationTime;
	rv.creationStack = this.creationStack;
	
	if (recurse)
		rv.childContexts = _.map(this.childContexts, function(c) { return c.getStatistics(true); });
	
	return rv;
};

exports.QContext = QContext;

function getStack() {
	var oldSTL, stack;
	
	oldSTL = Error.stackTraceLimit;
	Error.stackTraceLimit = Math.max(40, oldSTL); // at least 40
	stack = new Error().stack;
	Error.stackTraceLimit = oldSTL;
	
	return stack;
}

})();
