(function () { "use strict";

var _ = require('underscore');
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');
var os = require('os');
var cluster = require('cluster');

var qctx = require('./qctx.js');
var cfg = require('./config.js').config;
var bus = require('./bus/bus.js');
var buscomponent = require('./bus/buscomponent.js');
var pt = require('./bus/processtransport.js');

var af = require('./arivafinance.js');
var achievementList = require('./achievement-list.js');

var bwpid = null;

Error.stackTraceLimit = Infinity;

var mainBus = new bus.Bus();
var manager = new buscomponent.BusComponent();

mainBus.addInputFilter(function(packet) {
	if (packet.data && packet.data.ctx && !packet.data.ctx.toJSON)
		packet.data.ctx = qctx.fromJSON(packet.data.ctx, manager);
	
	return packet;
});

manager.getServerConfig = buscomponent.provide('getServerConfig', ['reply'], function(reply) { reply(cfg); });
manager.getAuthorizationKey = buscomponent.provide('getAuthorizationKey', ['reply'], function(reply) { reply(authorizationKey); });
manager.getStockQuoteLoader = buscomponent.provide('getStockQuoteLoader', ['reply'], function(reply) { reply(afql); });
manager.getAchievementList = buscomponent.provide('getAchievementList', ['reply'], function(reply) { reply(achievementList.AchievementList); });
manager.getClientAchievementList = buscomponent.provide('getClientAchievementList', ['reply'], function(reply) { reply(achievementList.ClientAchievements); });
manager.setBus(mainBus);

var afql = new af.ArivaFinanceQuoteLoader();

afql.on('error', function(e) { manager.emitError(e); });

process.on('uncaughtException', function(err) {
	manager.emitError(err);
	manager.emitImmediate('localShutdown');
});

var shutdownSignals = ['SIGTERM', 'SIGINT'];
for (var i = 0; i < shutdownSignals.length; ++i) {
	process.on(shutdownSignals[i], function() { mainBus.emitLocal('globalShutdown'); });
}

assert.ok(cfg.busDumpFile);
process.on('SIGUSR2', function() {
	fs.writeFileSync(cfg.busDumpFile.replace(/\{\$pid\}/g, process.pid), 'Log:\n\n' + JSON.stringify(mainBus.packetLog) + '\n\n\nUnanswered:\n\n' + JSON.stringify(mainBus.unansweredRequests()));
});

var authorizationKey;

if (cluster.isWorker) {
	authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString('ascii');
	
	mainBus.addTransport(new pt.ProcessTransport(process), worker);
} else {
	assert.ok(cluster.isMaster);
	
	authorizationKey = crypto.randomBytes(64).toString('hex');

	fs.writeFileSync(cfg['auth-key-file'], authorizationKey, {mode: 432});
	
	var workers = [];
	var assignedPorts = [];
	
	var getFreePort = function(pid) {
		// free all ports assigned to dead workers first
		var pids = _.chain(workers).pluck('process').pluck('pid').value();
		assignedPorts = _.filter(assignedPorts, function(p) { return pids.indexOf(p.pid) != -1; });
		
		var freePorts = _.difference(cfg.wsports, _.pluck(assignedPorts, 'port'));
		assert.ok(freePorts.length > 0);
		assignedPorts.push({pid: pid, port: freePorts[0]});
		return freePorts[0];
	};
	
	var registerWorker = function(w, done) {
		mainBus.addTransport(new pt.ProcessTransport(w), done);
	};
	
	var forkBackgroundWorker = function() {
		var bw = cluster.fork();
		workers.push(bw);
		
		bw.on('online', function() {
			registerWorker(bw, function() {
				bw.send({cmd: 'startBackgroundWorker'});
			});
		});
		
		bwpid = bw.process.pid;
		assert.ok(bwpid);
	};
	
	var forkStandardWorker = function() {
		var w = cluster.fork();
		workers.push(w);
		
		w.on('online', function() {
			registerWorker(w, function() {
				w.send({cmd: 'startStandardWorker', port: getFreePort(w.process.pid)});
			});
		});
	};
	
	forkBackgroundWorker();
	for (var i = 0; i < cfg.wsports.length; ++i) 
		forkStandardWorker();
	
	var shuttingDown = false;
	mainBus.on('globalShutdown', function() { mainBus.emitLocal('localShutdown'); });
	mainBus.on('localShutdown', function() { shuttingDown = true; });
	
	cluster.on('exit', function(worker, code, signal) {
		workers = _.filter(workers, function(w) { w.process.pid != worker.process.pid; });
		
		console.warn('worker ' + worker.process.pid + ' died with code ' + code + ', signal ' + signal + ' shutdown state ' + shuttingDown);
		
		if (!shuttingDown) {
			console.log('respawning');
			
			if (worker.process.pid == bwpid)
				forkBackgroundWorker();
			else 
				forkStandardWorker();
		}
	});
}

function worker() {
	process.on('message', function(msg) {
		if (msg.cmd == 'startBackgroundWorker') {
			process.isBackgroundWorker = true;
		} else if (msg.cmd == 'startStandardWorker') {
			assert.ok(msg.port);
			process.isBackgroundWorker = false;
		} else {
			return;
		}
		
		var loadComponents = [
			'./errorhandler.js', './emailsender.js', './dbbackend.js', './feed.js', './template-loader.js', './stocks.js', './user.js'
		].concat(process.isBackgroundWorker ? [
			'./background-worker.js', './dqueries.js'
		] : [
			'./admin.js', './schools.js', './fsdb.js', './achievements.js', './misc.js'
		]);

		for (var i = 0; i < loadComponents.length; ++i) {
			var c = require(loadComponents[i]);
			for (var j in c) 
				if (c[j] && c[j].prototype.setBus)
					new c[j]().setBus(mainBus, loadComponents[i].replace(/\.[^.]+$/, '').replace(/[^\w]/g, ''));
		}

		var server = require('./server.js');
		var stserver = new server.SoTradeServer().setBus(mainBus, 'serverMaster');
		
		if (process.isBackgroundWorker)
			console.log('bw started');
		else
			stserver.start(msg.port);
	});
}

})();
