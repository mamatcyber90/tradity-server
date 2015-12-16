(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var templates = require('./templates-compiled.js');
var debug = require('debug')('sotrade:template-loader');

/**
 * Provides methods for reading in template files.
 * 
 * @public
 * @module template-loader
 */

/**
 * Main object of the {@link module:template-loader} module
 * 
 * @public
 * @constructor module:template-loader~TemplateLoader
 * @augments module:stbuscomponent~STBusComponent
 */
class TemplateLoader extends buscomponent.BusComponent {
	constructor() {
		super();
	}
}

/**
 * Read a template and optionally substitute variables.
 * The strings which are substituted are of the format
 * <code>${varname}</code>.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {string} lang  The preferred language for the files to be read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @return {string} Returns the template, variables having been substituted.
 * 
 * @function busreq~readTemplate
 */
TemplateLoader.prototype.readTemplate = buscomponent.provide('readTemplate',
	['template', 'lang', 'variables'],
	function(template, lang, variables)
{
	var self = this;
	
	debug('Read template', template, lang, variables);
	
	return self.getServerConfig().then(function(cfg) {
		variables = variables || {};
		
		var t = templates[lang] && templates[lang][template];
		
		for (var i = 0; !t && i < cfg.languages.length; ++i)
			t = templates[cfg.languages[i].id][template];
		
		if (!t)
			throw new Error('Template not found: ' + template);
		
		_.chain(variables).keys().each(function(e) {
			var r = new RegExp('\\$\\{' + e + '\\}', 'g');
			t = t.replace(r, variables[e]);
		}).value();
		
		var unresolved = t.match(/\$\{([^\}]*)\}/);
		if (unresolved)
			throw new Error('Unknown variable “' + unresolved[1] + '” in template ' + template);
		
		return t;
	});
});

/**
 * Read an e-mail template and optionally substitute variables.
 * This internally calls {@link busreq~readTemplate} and has the same 
 * parameters, but header fields will be passend and an object suitable
 * for passing to {@link busreq~sendMail} is returned rather than a string.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {string} lang  The preferred language for the files to be read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @function busreq~readEMailTemplate
 */
TemplateLoader.prototype.readEMailTemplate = buscomponent.provide('readEMailTemplate',
	['template', 'lang', 'variables'], function(template, lang, variables) {
	return this.readTemplate(template, lang, variables).then(function(t) {
		var headerend = t.indexOf('\n\n');
		
		var headers = t.substr(0, headerend).split('\n');
		var body = t.substr(headerend + 2);
		
		var opt = {
			headers: {
				'X-SoTrade-Lang': lang
			}
		};
		
		for (var i = 0; i < headers.length; ++i) {
			var h = headers[i];
			var headerNameEnd = h.indexOf(':');
			var headerName = h.substr(0, headerNameEnd).trim();
			var headerValue = h.substr(headerNameEnd + 1).trim();
			
			var camelCaseHeaderName = headerName.toLowerCase().replace(/-\w/g, function(w) { return w.toUpperCase(); }).replace(/-/g, '');
			
			if (['subject', 'from', 'to'].indexOf(camelCaseHeaderName) != -1)
				opt[camelCaseHeaderName] = headerValue;
			else
				opt.headers[headerName] = headerValue;
		}
		
		opt.html = body;
		opt.generateTextFromHTML = true;
		return opt;
	});
});

exports.TemplateLoader = TemplateLoader;

})();

