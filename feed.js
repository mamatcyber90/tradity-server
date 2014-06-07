(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function FeedControllerDB () {
};

util.inherits(FeedControllerDB, buscomponent.BusComponent);

FeedControllerDB.prototype.feed = buscomponent.provide('feed', ['data', 'reply'], function(data, onEventId) {
	assert.ok(data.type);
	assert.ok(data.type.length);
	assert.ok(data.srcuser);
	
	var json = JSON.stringify(data.json ? data.json : {});
	data = _.extend(data, data.json);
	
	process.nextTick(_.bind(function() {
		this.emit('feedevent', data);
		this.emit('feed-' + data.type, data);
	}, this));
	
	this.query('INSERT INTO events(`type`,targetid,time,srcuser,json) VALUES (?,?,UNIX_TIMESTAMP(),?,?)',
		[data.type, data.targetid, data.srcuser, json], function(r) {
		var eventid = r.insertId;
		onEventId(eventid);
		
		var query, params, subselects;
		
		if (!data.everyone) {
			var additional = data.feedusers && data.feedusers.slice(0) || [];
			if (additional.indexOf(data.srcuser) == -1)
				additional.push(data.srcuser);
			
			query = 'INSERT INTO events_users (eventid,userid) ';
			subselects = [];
			params = [];
			
			if (!data.noFollowers) {
				subselects.push('SELECT ?,userid FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id AND s.leader = ?'); // all followers
				subselects.push('SELECT ?,w.watcher FROM stocks AS s JOIN watchlists AS w ON s.id = w.watched WHERE s.leader = ?'); // all users in watchlist
				params = params.concat([eventid, data.srcuser, eventid, data.srcuser]);
			}
			
			if (data.feedschool) {
				subselects.push(
					'SELECT ?, sm.uid FROM schools AS p ' +
					'JOIN schools AS c ON c.path LIKE CONCAT(p.path, "%") OR p.id = c.id ' +
					'JOIN schoolmembers AS sm ON sm.schoolid = c.id AND sm.pending = 0 ' +
					'WHERE p.id = ?');
				params = params.concat([eventid, data.feedschool]);
			}
			
			if (data.feedchat) {
				subselects.push('SELECT ?, userid FROM chatmembers WHERE chatid = ?');
				params = params.concat([eventid, data.feedchat]);
			}
			 
			for (var i = 0; i < additional.length; ++i) {
				if (parseInt(additional[i]) != additional[i])
					return this.emit('error', new Error('Bad additional user for feed event: ' + additional[i]));
				
				subselects.push('SELECT ?,?');
				params = params.concat([eventid, additional[i]]);
			}
			query += subselects.join(' UNION ');
		} else {
			query = 'INSERT INTO events_users (eventid, userid) SELECT ?, id FROM users';
			params = [eventid];
		}
		
		this.query(query, params, function() {
			this.emit('push-events');
		});
	});
});

FeedControllerDB.prototype.fetchEvents = buscomponent.provideQUA('feedFetchEvents', function(query, user, access, cb) {
	this.query('SELECT events.*, events_users.*, c.*, oh.*, events.time AS eventtime, events.eventid AS eventid, ' +
		'e2.eventid AS baseeventid, e2.type AS baseeventtype, trader.id AS traderid, trader.name AS tradername, ' +
		'schools.id AS schoolid, schools.name AS schoolname, schools.path AS schoolpath, '+
		'su.name AS srcusername, notif.content AS notifcontent, notif.sticky AS notifsticky, url AS profilepic, ' +
		'achievements.achname, achievements.xp ' +
		'FROM events_users ' +
		'JOIN events ON events_users.eventid = events.eventid ' +
		'LEFT JOIN ecomments AS c ON c.commentid = events.targetid AND events.type="comment" ' +
		'LEFT JOIN events AS e2 ON c.eventid = e2.eventid ' +
		'LEFT JOIN orderhistory AS oh ON (e2.targetid = oh.orderid AND e2.type="trade") OR (oh.orderid = events.targetid AND events.type="trade") ' +
		'LEFT JOIN users AS su ON su.id = events.srcuser ' +
		'LEFT JOIN users AS trader ON (trader.id = oh.userid AND e2.type="trade") OR (trader.id = e2.targetid AND e2.type="user-register") ' +
		'LEFT JOIN schools ON schools.id = e2.targetid AND e2.type="school-create" ' +
		'LEFT JOIN achievements ON achievements.achid = events.targetid AND events.type="achievement" ' +
		'LEFT JOIN mod_notif AS notif ON notif.notifid = events.targetid AND events.type="mod-notification" ' +
		'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" ' +
		'WHERE events_users.userid = ? AND events.time > ? ORDER BY events.time DESC LIMIT ?',
		[user.uid, query ? query.since : 0, query && query.count !== null ? query.count : 100000], function(r) {
		cb(_.chain(r).map(function(ev) {
			if (ev.json) {
				var json = JSON.parse(ev.json);
				if (json.__delay__ && (new Date().getTime()/1000 - ev.eventtime < json.__delay__) && user.uid != ev.srcuser)
					return null;
				ev = _.extend(ev, json);
			}
			
			delete ev.json;
			return ev;
		}).reject(function(ev) { return !ev; }).value());
	});
});

FeedControllerDB.prototype.markAsSeen = buscomponent.provideQUA('client-mark-as-seen', function(query, user, access, cb) {
	if (parseInt(query.eventid) != query.eventid)
		return cb('format-error');
	
	this.query('UPDATE events_users SET seen = 1 WHERE eventid = ? AND userid = ?', [query.eventid, user.id], function() {
		cb('mark-as-seen-success');
	});
});

FeedControllerDB.prototype.commentEvent = buscomponent.provideQUA('client-comment', function(query, user, access, cb) {
	if (!query.comment)
		return cb('format-error');
	
	this.query('SELECT events.type,events.targetid,oh.userid AS trader FROM events '+
		'LEFT JOIN orderhistory AS oh ON oh.orderid = events.targetid WHERE eventid = ?', [query.eventid], function(res) {
		if (res.length == 0)
			return cb('comment-notfound');
		
		var feedschool = null;
		var feedchat = null;
		var feedusers = [];
		var r = res[0];
		var noFollowers = false;
		
		switch (r.type) {
			case 'user-register':
				assert.notStrictEqual(r.targetid, null);
				feedusers.push(r.targetid);
				break;
			case 'trade':
				assert.notStrictEqual(r.trader, null);
				feedusers.push(r.trader);
				break;
			case 'school-create':
				assert.notStrictEqual(r.targetid, null);
				feedschool = r.targetid;
				break;
			case 'chat-start':
				assert.notStrictEqual(r.targetid, null);
				feedchat = r.targetid;
				noFollowers = true;
				break;
		}
		
		this.query('INSERT INTO ecomments (eventid, commenter, comment, trustedhtml, time) VALUES(?, ?, ?, ?, UNIX_TIMESTAMP())', 
			[query.eventid, user.id, query.comment, query.ishtml && access.has('comments') ? 1 : 0], function(res) {
			this.feed({
				type: 'comment',
				targetid: res.insertId,
				srcuser: user.id,
				feedusers: feedusers,
				feedschool: feedschool,
				feedchat: feedchat,
				noFollowers: noFollowers
			}, function() {});
			cb('comment-success');
		});
	});
});

exports.FeedControllerDB = FeedControllerDB;

})();
