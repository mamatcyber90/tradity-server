(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var Q = require('q');
var assert = require('assert');
var nodemailer = require('nodemailer');
var commonUtil = require('./common/util.js');
var serverUtil = require('./server-util.js');
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');

/**
 * Provides methods for sending e-mails.
 * 
 * @public
 * @module emailsender
 */

/**
 * Main object of the {@link module:emailsender} module
 * 
 * @public
 * @constructor module:emailsender~Mailer
 * @augments module:stbuscomponent~STBusComponent
 */
function Mailer () {
	Mailer.super_.apply(this, arguments);
	this.mailer = null;
};

util.inherits(Mailer, buscomponent.BusComponent);

Mailer.prototype._init = function(cb) {
	var self = this;
	
	return this.getServerConfig().then(function(cfg) {
		self.mailer = nodemailer.createTransport(cfg.mail.transport(cfg.mail.transportData));
		self.inited = true;
		return cb();
	});
};

/**
 * Send an e-mail based on a template.
 * This is basically a composition of {@link busreq~readEMailTemplate}
 * and {@link busreq~sendMail}.
 * 
 * @param {object} variables  See {@link busreq~readEMailTemplate}.
 * @param {string} template  See {@link busreq~readEMailTemplate}.
 * @param {string} mailtype  See {@link busreq~sendMail}.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function busreq~sendTemplateMail
 */
Mailer.prototype.sendTemplateMail = buscomponent.provide('sendTemplateMail',
	['variables', 'template', 'ctx', 'mailtype', 'reply'],
	function(variables, template, ctx, mailtype, cb) {
	var self = this;
	
	return self.request({name: 'readEMailTemplate', 
		template: template,
		variables: variables || {},
	}).then(function(opt) {
		return self.sendMail(opt, ctx, template, mailtype || opt.headers['X-Mailtype'] || '', cb);
	});
});

/**
 * Information about an email which could not be delivered.
 * 
 * @typedef s2c~email-bounced
 * @type {Event}
 * 
 * @property {string} messageid  The RFC822 Message-Id of the non-delivered e-mail.
 * @property {int} sendingtime  The unix timestamp of the message leaving the server.
 * @property {int} bouncetime  The unix timestamp of receiving the failure notification.
 * @property {string} mailtype  The e-mail type as set by the caller of
 *                              {@link busreq~sendMail}.
 * @property {string} mailrecipient  The <code>To:</code> mail adress.
 * @property {string} diagnostic_code  The diagnostic code send by the rejecting server.
 */

/**
 * Notifies the server about the non-delivery of mails.
 * This requires appropiate privileges.
 * 
 * @param {string} query.messageId  The RFC822 Message-Id of the e-mail as set
 *                                  by this server during sending of the mail.
 * @param {?string} query.diagnostic_code  A diagnostic code set in the e-mail.
 *                                         This may be displayed to users in order
 *                                         to help troubleshooting problems.
 * 
 * @return {object}  Returns with <code>email-bounced-notfound</code>,
 *                   <code>email-bounced-success</code> or a common error code.
 * 
 * @function c2s~email-bounced
 */
Mailer.prototype.emailBounced = buscomponent.provideW('client-email-bounced', ['query', 'internal', 'ctx', 'reply'],
	function(query, internal, ctx, cb)
{
	cb = cb || function() {};
	
	if (!ctx)
		ctx = new qctx.QContext({parentComponent: this});
	
	if (!internal && !ctx.access.has('email-bounces'))
		return cb('permission-denied');
	
	return ctx.query('SELECT mailid, uid FROM sentemails WHERE messageid = ?', [String(query.messageId)]).then(function(r) {
		if (r.length == 0)
			return cb('email-bounced-notfound');
		
		assert.equal(r.length, 1);
		var mail = r[0];
		
		return ctx.query('UPDATE sentemails SET bouncetime = UNIX_TIMESTAMP(), diagnostic_code = ? WHERE mailid = ?',
			[String(query.diagnostic_code || ''), mail.mailid]);
	}).then(function() {
		return ctx.feed({
			'type': 'email-bounced',
			'targetid': mail.mailid,
			'srcuser': mail.uid,
			'noFollowers': true
		});
	}).then(function() {
		return cb('email-bounced-success');
	});
});

/**
 * Send an e-mail to a user.
 * 
 * @param {object} opt  General information about the mail. The format of this
 *                      is specified by the underlying SMTP module
 *                      (i.e. <code>nodemailer</code>).
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {string} template  The name of the template used for e-mail generation.
 * @param {string} mailtype  An identifer describing the kind of sent mail.
 *                           This is useful for displaying it to the user in case
 *                           of delivery failure.
 * 
 * @function busreq~sendMail
 */
Mailer.prototype.sendMail = buscomponent.provide('sendMail',
	['opt', 'ctx', 'template', 'mailtype', 'reply'],
	buscomponent.needsInit(function(opt, ctx, template, mailtype, cb)
{
	var self = this;
	
	assert.ok(self.mailer);
	
	return self.getServerConfig().then(function(cfg) {
		var origTo = opt.to;
		
		if (cfg.mail.forceTo)
			opt.to = cfg.mail.forceTo;
		if (cfg.mail.forceFrom)
			opt.from = cfg.mail.forceFrom;
		
		var shortId = serverUtil.sha256(Date.now() + JSON.stringify(opt)).substr(0, 24) + commonUtil.locallyUnique();
		opt.messageId = '<' + shortId + '@' + cfg.mail.messageIdHostname + '>';
		
		if (ctx && !ctx.getProperty('readonly'))
			return ctx.query('INSERT INTO sentemails (uid, messageid, sendingtime, templatename, mailtype, recipient) ' +
				'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
				[(ctx.user && ctx.user.id) || null, String(shortId), String(template) || null,
				String(mailtype), String(origTo)]);
		
		return Q(null);
	}).then(function() {
		return Q.nfcall(self.mailer.sendMail, opt);
	}).then(function(status) {
		if (status && status.rejected.length > 0)
			self.emailBounced({messageId: shortId}, true, ctx);
		
		
		return cb();
	}, function(err) {
		self.emailBounced({messageId: shortId}, true, ctx);
			
		if (err)
			self.emitError(err);
		
		return cb();
	});
}));

exports.Mailer = Mailer;

})();

