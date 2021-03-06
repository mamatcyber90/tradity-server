// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const request = require('request');
const assert = require('assert');
const stream = require('readable-stream');
const sha256 = require('./lib/sha256.js');
const qctx = require('./qctx.js');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const debug = require('debug')('sotrade:fsdb');

class FSDBRequestable extends api.Requestable {
  constructor() {
    super({
      url: '/dynamic/files/:filename',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The filename to look up.'
          }
        },
        required: ['filename']
      },
      description: 'Handles an HTTP file request for user-uploaded resources.'
    });
  }
  
  _handleRequest(req, res, uriMatch, defaultHeaders) {
    const ctx = new qctx.QContext({parentComponent: this});
    const cfg = this.load('Config').config();
    
    const filename = uriMatch.filename;
    let headers, r;
    
    debug('Requested file', filename);
    
    return ctx.query('SELECT * FROM httpresources WHERE name = ?', [filename]).then(rows => {
      if (rows.length === 0) {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not found');
        return null;
      }
      
      assert.equal(rows.length, 1);
      
      r = rows[0];
      
      headers = Object.assign({
        'Date': new Date().toString(),
        'X-Sotrade-Hash': r.hash,
        'X-Sotrade-Source-User-ID': r.user,
        'X-Sotrade-Name': r.name,
        'X-Sotrade-Role': r.role,
        'X-Sotrade-Groupassoc': r.groupassoc,
        'X-Sotrade-Proxied': r.proxy
      }, defaultHeaders);
      
      if (!r.proxy) {
        headers['Content-Type'] = r.mime;
        headers['Cache-Control'] = r.cache ? 'max-age=100000000' : 'no-cache';
        headers['Last-Modified'] = new Date(r.uploadtime * 1000).toString();
        
        if (req.headers['if-modified-since']) {
          return { code: 304, finalize: res => res.end };
        } else {
          if (r.gzipped) {
            headers['Content-Encoding'] = 'gzip';
          }
          
          return { code: 200, finalize: res => res.end(r.content) };
        }
      }
      
      // create a PassThrough stream to buffer up data while we are already
      // reading the response and have not written all headers yet
      const dataPassThrough = new stream.PassThrough();
      
      return (new Promise((resolve, reject) => {
        const proxyURL = r.content.toString('utf8');
        
        request.get(proxyURL, {
          headers: {
            'If-Modified-Since': req.headers['if-modified-since'],
            'User-Agent': cfg.userAgent
          }
        }).on('response', resolve)
          .on('error', e => {
            this.load('PubSub').emit('error', e);
            reject(e);
          })
          .pipe(dataPassThrough);
      })).then(resp => {
        const pheaders = Object.assign(
          ...['cache-control', 'expires', 'last-modified', 'source-age', 'content-type']
            .map(header => ({
              [header.replace(/(-|^)\w/g, w => w.toUpperCase())]: resp.headers[header]
            }))
          );
        
        Object.assign(headers, pheaders);
        
        return { code: resp.statusCode, finalize: res => dataPassThrough.pipe(res) };
      });
    }).then(resultInfo => {
      if (!resultInfo) {
        return;
      }
      
      let sendHeaders = headers;
      if (r.headers) {
        sendHeaders = Object.assign({}, headers, JSON.parse(r.headers));
      }
      
      res.writeHead(resultInfo.code, sendHeaders);
      resultInfo.finalize(res);
    });
  }
}

/**
 * Indicates the upload of files by users.
 * 
 * @typedef s2c~file-publish
 * @type {Event}
 */

/** */
class FSDBPublish extends api.Requestable {
  constructor() {
    super({
      identifier: 'PublishFile',
      url: '/dynamic/files',
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'proxy-not-allowed' },
        { code: 403, identifier: 'inacceptable-role' },
        { code: 415, identifier: 'inacceptable-mime' },
        { code: 413, identifier: 'quota-exceeded' }
      ],
      transactional: true,
      schema: {
        type: 'object',
        properties: {
          // Note: The MIME type is read from the request headers
          proxy: {
            type: 'boolean',
            description: 'Whether the content of this file is hosted remotely and this software acts as a proxy'
          },
          role: {
            type: 'string',
            description: 'A string identifying the role of this file',
            notes: 'Allowed roles and user-unique roles can be specified in the server config.'
          }
        }
      },
      description: 'Publishes a file.',
      notes: 'The Content-Length and Content-Type headers need to be set.'
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata, groupInfo) {
    groupInfo = groupInfo || {};
    
    let uniqrole, filehash, filename, url, mime, length, groupassoc, totalUsedBytes, content;
    const role = groupInfo.role || query.role;
    
    return Promise.resolve().then(() => {
      mime = xdata.headers['content-type'] || 'application/octet-stream';
      length = parseInt(xdata.headers['content-length']);
      
      if (length < 0 || isNaN(length)) {
        throw this.BadRequest(new TypeError('Content-Length header needs integer value'), 400);
      }
      
      debug('Upload file', mime, role);
    
      uniqrole = cfg.fsdb.uniqroles[role];
    
      return uniqrole ? [{total: 0}] :
        ctx.query('SELECT SUM(LENGTH(content)) AS total FROM httpresources WHERE uid = ? FOR UPDATE',
          [ctx.user ? ctx.user.uid : null]);
    }).then(res => {
      totalUsedBytes = res[0].total;
      
      if (!ctx.access.has('filesystem')) {
        // some access tests
      
        if (length + totalUsedBytes > cfg.fsdb.userquota) {
          throw new this.ClientError('quota-exceeded');
        }
        
        if (cfg.fsdb.allowroles.indexOf(role) === -1) {
          throw new this.ClientError('inacceptable-role');
        }
      }
      
      return promiseUtil.bufferFromStream(xdata.rawRequest);
    }).then(content_ => {
      content = content_;
      
      if (ctx.access.has('filesystem')) {
        // we can skip the rest of the access tests
        return;
      }
      
      if (content.length + totalUsedBytes > cfg.fsdb.userquota) {
        throw new this.ClientError('quota-exceeded');
      }
      
      if (query.proxy) {
        let hasRequiredAccess = false;
        
        for (let i = 0; i < cfg.fsdb.allowProxyURIs.length && !hasRequiredAccess; ++i) {
          const p = cfg.fsdb.allowProxyURIs[i];
          assert.ok(p.regex);
          assert.ok(p.requireAccess);
          
          const match = query.content.match(p.regex);
          if (match) {
            if (typeof p.requireAccess === 'function') {
              hasRequiredAccess = p.requireAccess(ctx, match);
            } else {
              hasRequiredAccess = p.requireAccess.length === 0;
              for (let i = 0; i < p.requireAccess.length; ++i) {
                if (ctx.access.has(p.requireAccess[i])) {
                  hasRequiredAccess = true;
                  break;
                }
              }
            }
          }
        }
        
        if (!hasRequiredAccess) {
          throw new this.ClientError('proxy-not-allowed');
        }
      } else {
        // local mime type is ignored for proxy requests
        
        if (cfg.fsdb.allowmime.indexOf(mime) === -1) {
          throw new this.ClientError('inacceptable-mime');
        }
      }
    }).then(() => {
      filehash = sha256(content + String(Date.now())).substr(0, 32);
      const name = query.name ? String(query.name) : filehash;
      
      filename = (ctx.user ? ctx.user.uid + '-' : '') + ((Date.now()) % 8192) + '-' + name.replace(/[^-_+\w\.]/g, '');
      url = cfg.varReplace(cfg.fsdb.puburl.replace(/\{\$name\}/g, filename));
      
      groupassoc = parseInt(groupInfo.groupassoc);
      if (isNaN(groupassoc)) {
        groupassoc = null;
      }
      
      if (uniqrole && ctx.user && !(ctx.access.has('filesystem') && query.retainOldFiles)) {
        let sql = 'DELETE FROM httpresources WHERE role = ? ';
        let dataarr = [role];
        
        for (let i = 0; i < uniqrole.length; ++i) {
          const fieldname = uniqrole[i];
          sql += 'AND `' + fieldname + '` = ? ';
          
          switch (fieldname) {
            case 'uid': dataarr.push(ctx.user.uid); break;
            case 'groupassoc': dataarr.push(groupassoc); break;
            default: this.load('PubSub').emit('error', new Error('Unknown uniqrole field: ' + fieldname));
          }
        }
        
        return ctx.query(sql, dataarr);
      }
    }).then(() => {
      return ctx.query('INSERT INTO httpresources(uid, name, url, mime, hash, role, uploadtime, content, groupassoc, proxy) '+
        'VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
        [ctx.user ? ctx.user.uid : null, filename, url, mime, filehash,
        role, content, groupassoc, query.proxy ? 1:0]);
    }).then(res => {
      if (ctx.user) {
        return ctx.feed({
          'type': 'file-publish',
          'targetid': res.insertId,
          'srcuser': ctx.user.uid,
          'ctx': ctx
        });
      }
    }).then(() => {
      return { code: 200, repush: true, filename: filename };
    });
  }
}

exports.components = [
  FSDBRequestable,
  FSDBPublish
];
