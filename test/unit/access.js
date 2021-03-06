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

'use strict';

const assert = require('assert');

const Access = require('../../access.js').Access;

describe('Access', function() {
  describe('#clone', function() {
    it('should create an independent copy', function() {
      const a = new Access();
      a.grant('a');
      assert.ok(a.has('a'));
      
      const c = a.clone();
      assert.ok(c.has('a'));
      assert.ok(!c.has('b'));
      
      c.grant('b');
      
      assert.ok(c.has('b'));
      assert.ok(!a.has('b'));
    });
  });
  
  describe('#toString', function() {
    it('should return a string representation', function() {
      const a = new Access();
      a.grant('a');
      
      assert.equal(String(a), '["a"]');
    });
  });
  
  describe('#toJSON', function() {
    it('should return a string representation', function() {
      const a = new Access();
      a.grant('a');
      
      assert.equal(String(a), '["a"]');
    });
    
    it('should return a string representation for the any access wildcard', function() {
      const a = new Access();
      a.grantAny();
      
      assert.equal(String(a), '["*"]');
    });
  });
  
  describe('#toArray', function() {
    it('should return an array of accessible areas', function() {
      const a = new Access();
      a.grant('a');
      a.grant('b');
      
      assert.deepEqual(a.toArray().sort(), ['a', 'b']);
    });
    
    it('should return an array of accessible areas with any access', function() {
      const a = new Access();
      a.grantAny();
      a.grant('b');
      
      assert.deepEqual(a.toArray().sort(), ['*']);
    });
  });
  
  describe('#update', function() {
    it('should merge two Access objects', function() {
      const a = Access.fromJSON('["a", "b"]');
      const b = Access.fromJSON('["c", "d"]');
      
      a.update(b);
      assert.deepEqual(a.toArray().sort(), ['a', 'b', 'c', 'd']);
    });
    
    it('should merge two Access objects with any access', function() {
      const a = Access.fromJSON('["a", "b"]');
      const b = Access.fromJSON('["*"]');
      
      a.update(b);
      assert.deepEqual(a.toArray().sort(), ['*']);
    });
  });
  
  describe('#grant', function() {
    it('should ignore empty strings', function() {
      const a = new Access();
      a.grant('');
      
      assert.strictEqual(a.toArray().length, 0);
    });
    
    it('should ignore doubles', function() {
      const a = new Access();
      a.grant('a');
      a.grant('a');
      
      assert.deepEqual(a.toArray().sort(), ['a']);
    });
  });
  
  describe('#drop', function() {
    it('should remove access areas', function() {
      const a = new Access();
      a.grant('a');
      a.grant('b');
      a.drop('a');
      
      assert.deepEqual(a.toArray().sort(), ['b']);
    });
    
    it('should remove any access areas', function() {
      const a = new Access();
      a.grant('*');
      a.grant('b');
      a.drop('*');
      
      assert.deepEqual(a.toArray().sort(), ['b']);
    });
    
    it('should ignore empty strings', function() {
      const a = new Access();
      a.grant('a');
      a.grant('b');
      a.drop('');
      
      assert.deepEqual(a.toArray().sort(), ['a', 'b']);
    });
  });
  
  describe('#dropAll', function() {
    it('should remove all access', function() {
      const a = new Access();
      a.grant('a');
      a.grant('b');
      a.dropAll();
      
      assert.deepEqual(a.toArray().sort(), []);
    });
    
    it('should remove any wildcard access', function() {
      const a = new Access();
      a.grant('*');
      a.grant('b');
      a.dropAll();
      
      assert.deepEqual(a.toArray().sort(), []);
    });
  });
  
  describe('fromJSON', function() {
    it('Converts an empty string to a simple access object', function() {
      const a = Access.fromJSON('');
      
      assert.deepEqual(a.toArray().sort(), []);
    });
    
    it('Converts "*" to a simple access object', function() {
      const a = Access.fromJSON('*');
      
      assert.deepEqual(a.toArray().sort(), ['*']);
      assert.ok(a.has('*'));
    });
  });
});
