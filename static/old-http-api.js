var API = (function() {
	"use strict";
	var sid, url, user_id, api_key;
	var sync, sync_params, sync_stopped, sync_timeout_id, sync_error_count, sync_resync, sync_permastop;
	var sync_timeout_error_removal_timeout;
	var async, async_queue, async_current;
	var callbacks = {};
	var offline_ack = false;
	var known_event_id = 0;
	var is_dj = false;

	var self = {};
	self.last_action = null;
	self.paused = false;

	self.is_slow = false;
	self.net_latencies = [];
	self.draw_latencies = [];
	var slow_net_threshold = 200;
	var slow_draw_threshold = 400;

	self.initialize = function(n_sid, n_url, n_user_id, n_api_key, json) {
		self.is_slow =
			navigator.userAgent.toLowerCase().indexOf("mobile") !== -1 ||
			navigator.userAgent.toLowerCase().indexOf("android") !== -1;

		sid = n_sid;
		url = n_url;
		user_id = n_user_id;
		api_key = n_api_key;
		is_dj = json && json.user && json.user.dj;

		sync = new XMLHttpRequest();
		sync.onload = sync_complete;
		sync.onerror = sync_error;
		sync.ontimeout = sync_error;
		sync_params = self.serialize({ sid: sid, user_id: user_id, key: api_key });
		sync_stopped = false;
		sync_resync = false;
		sync_error_count = 0;

		async = new XMLHttpRequest();
		async.onload = async_complete;
		async.onerror = async_error;
		async.ontimeout = async_timeout;
		async_queue = [];

		if ("sched_current" in json) {
			known_event_id = json.sched_current.id;
		}
		self.add_callback("sched_current", function(json) {
			known_event_id = json.id;
		});

		// Make sure the clock gets initialized first
		perform_callbacks({ api_info: json.api_info });

		// Call back the heavy playlist functions first
		// This will prevent animation hitching
		// var lists = [ "all_albums", "all_artists", "current_listeners", "request_line" ];
		// var temp_json;
		// for (var i = 0; i < lists.length; i++) {
		// 	if (lists[i] in json) {
		// 		temp_json = {};
		// 		temp_json[lists[i]] = json[lists[i]];
		// 		perform_callbacks(temp_json);
		// 		delete(json[lists[i]]);
		// 	}
		// }

		perform_callbacks({ _SYNC_START: true });
		perform_callbacks(json);
		perform_callbacks({ _SYNC_COMPLETE: true });
		if ("sched_current" in json) {
			perform_callbacks({ _SYNC_SCHEDULE_COMPLETE: true });
		}
		// Make sure any vote results are registered now (after the schedule has been loaded)
		if ("already_voted" in json) {
			perform_callbacks({ already_voted: json.already_voted });
		}

		// only handle browser closing/opening on mobile
		if (typeof visibilityEventNames !== "undefined" && visibilityEventNames.change && document.addEventListener) {
			if (
				MOBILE ||
				navigator.userAgent.toLowerCase().indexOf("mobile") !== -1 ||
				navigator.userAgent.toLowerCase().indexOf("android") !== -1
			) {
				document.addEventListener(visibilityEventNames.change, handle_visibility_change, false);
			}
		}

		sync_get();
	};

	var handle_visibility_change = function() {
		if (!sync_stopped) return;
		if (document[visibilityEventNames.hidden]) {
			sync_pause();
		} else {
			sync_get();
		}
	};

	// easy to solve, but stolen from http://stackoverflow.com/questions/1714786/querystring-encoding-of-a-javascript-object
	self.serialize = function(obj) {
		var str = [];
		for (var p in obj) {
			str.push(p + "=" + encodeURIComponent(obj[p]));
		}
		return str.join("&");
	};

	var sync_get = function() {
		if (sync_permastop) return;
		sync_stopped = false;
		if (!is_dj) {
			sync.open("POST", url + "sync", true);
		} else {
			sync.open("POST", url + "sync_dj", true);
		}
		sync.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
		clear_sync_timeout_error_removal_timeout();
		sync_timeout_error_removal_timeout = setTimeout(clear_sync_timeout_error, 15000);
		var local_sync_params = sync_params;
		if (offline_ack) {
			local_sync_params += "&offline_ack=true";
		}
		if (sync_resync) {
			local_sync_params += "&resync=true";
			sync_resync = false;
		}
		local_sync_params += "&known_event_id=" + known_event_id;
		sync.send(local_sync_params);
	};

	var clear_sync_timeout_error_removal_timeout = function() {
		if (sync_timeout_error_removal_timeout) {
			clearTimeout(sync_timeout_error_removal_timeout);
		}
		sync_timeout_error_removal_timeout = null;
	};

	var clear_sync_timeout_error = function() {
		sync_timeout_error_removal_timeout = null;
		if (typeof ErrorHandler !== "undefined") {
			ErrorHandler.remove_permanent_error("sync_retrying");
		}
	};

	var sync_pause = function() {
		clear_sync_timeout_error_removal_timeout();
		sync_clear_timeout();
		sync_stopped = true;
		sync.abort();
	};

	self.sync_stop = function() {
		sync_pause();
		sync_permastop = true;
		if (typeof ErrorHandler !== "undefined") {
			ErrorHandler.permanent_error(ErrorHandler.make_error("sync_stopped", 500));
		}
	};

	var sync_clear_timeout = function() {
		if (sync_timeout_id) {
			clearTimeout(sync_timeout_id);
			sync_timeout_id = null;
		}
	};

	var sync_error = function() {
		clear_sync_timeout_error_removal_timeout();
		var result;
		try {
			if (sync.responseText) {
				result = JSON.parse(sync.responseText);
			}
		} catch (exc) {
			// do nothing
		}
		sync_resync = true;
		sync_error_count++;
		// if (sync_error_count > 4) {
		// 	ErrorHandler.remove_permanent_error("sync_retrying");
		// 	var e = ErrorHandler.make_error("sync_stopped", 500);
		// 	if (result && result.sync_result && result.sync_result.tl_key) {
		// 		e.text += " (" + $l(result.sync_result.tl_key) + ")";
		// 	}
		// 	else if (result && result.error && result.error.tl_key) {
		// 		e.text += " (" + $l(result.error.tl_key) + ")";
		// 	}
		// 	else if (result && result[0] && result[0].error && result[0].error.tl_key) {
		// 		e.text += " (" + $l(result[0].error.tl_key) + ")";
		// 	}
		// 	else {
		// 		e.text += " (" + $l("lost_connection") + ")";
		// 	}
		// 	ErrorHandler.permanent_error(e);
		// 	self.sync_stop();
		// 	sync_permastop = true;
		// }
		if (sync_error_count > 1) {
			if (typeof ErrorHandler !== "undefined") {
				ErrorHandler.permanent_error(ErrorHandler.make_error("sync_retrying", 408));
			}
			sync_timeout_id = setTimeout(sync_get, 4000);
		} else {
			sync_timeout_id = setTimeout(sync_get, 4000);
		}
	};

	var check_sync_results = function(response) {
		if ("info_result" in response) {
			response.sync_result = response.info_result;
		}
		if ("sync_result" in response && response.sync_result.tl_key == "station_offline") {
			if (typeof ErrorHandler !== "undefined") {
				ErrorHandler.permanent_error(response.sync_result);
			}
			offline_ack = true;
			self.paused = false;
			return true;
		} else {
			if (typeof ErrorHandler !== "undefined") {
				ErrorHandler.remove_permanent_error("station_offline");
			}
		}
		if ("sync_result" in response && response.sync_result.tl_key == "station_paused") {
			self.paused = true;
			offline_ack = true;
			return true;
		}
		if ("sync_dj_result" in response && response.sync_dj_result.tl_key == "station_paused") {
			self.paused = true;
			offline_ack = true;
			return true;
		}
		return false;
	};

	var sync_complete = function() {
		clear_sync_timeout_error_removal_timeout();

		// if the API is outputting JSON it always outputs status code 200
		// the error code, if any, lives in error.code
		if (sync.status != 200) {
			return sync_error();
		}

		var sync_restart_pause = 3000;

		var response;
		try {
			response = JSON.parse(sync.responseText);
		} catch (e) {
			return sync_error();
		}

		if (check_sync_results(response)) {
			sync_restart_pause = 300;
		} else {
			self.paused = false;
			sync_error_count = 0;
			offline_ack = false;
			perform_callbacks({ _SYNC_START: true });
			perform_callbacks(response);
			perform_callbacks({ _SYNC_COMPLETE: true });
			if ("error" in response) {
				sync_restart_pause = 6000;
			} else {
				clear_sync_timeout_error();
			}
		}

		if (!sync_stopped && !sync_permastop) {
			sync_timeout_id = setTimeout(sync_get, sync_restart_pause);
		}
	};

	self.force_sync = function() {
		if (sync_permastop || sync_stopped) {
			return;
		}
		sync_pause();
		sync_get();
	};

	self.sync_status = function() {
		console.log("XHR        : ", sync);
		console.log("Offline Ack: ", offline_ack);
		console.log("Sta. Pause : ", self.paused);
		console.log("Stopped    : ", sync_stopped);
		console.log("Permastop  : ", sync_permastop);
		console.log("Error Count: ", sync_error_count);
		console.log("Resync     : ", sync_resync);
	};

	var async_timeout = function() {
		if (typeof ErrorHandler !== "undefined") {
			ErrorHandler.permanent_error(ErrorHandler.make_error("sync_stopped", 500));
		}
		self.async_get();
	};

	var async_error = function(json) {
		var do_default = true;
		if (async_current.error_callback) {
			if (async_current.error_callback(json)) {
				do_default = false;
			}
		}
		if (do_default && json) {
			if (typeof ErrorHandler !== "undefined") {
				ErrorHandler.tooltip_error(json);
			}
		} else if (do_default) {
			if (typeof ErrorHandler !== "undefined") {
				ErrorHandler.tooltip_error(ErrorHandler.make_error("async_error", async.status));
			}
		}
		self.async_get();
	};

	var async_complete = function() {
		if (typeof ErrorHandler !== "undefined") {
			ErrorHandler.remove_permanent_error("async_error");
		}

		var json;
		if (async.responseType === "json") {
			json = async.response;
		} else {
			try {
				json = JSON.parse(async.response);
			} catch (e) {
				// nothing
			}
		}

		var net_slow = false;
		var avg;
		if (
			(async_current && async_current.action == "album") ||
			async_current.action == "artist" ||
			async_current.action == "group"
		) {
			self.net_latencies.push(new Date() - async_current.start);
			avg = 0;
			while (self.net_latencies.length > 10) {
				self.net_latencies.shift();
			}
			for (i = 0; i < self.net_latencies.length; i++) {
				avg += self.net_latencies[i];
			}
			avg = avg / self.net_latencies.length;
			if (avg > slow_net_threshold) {
				net_slow = true;
			}
		}

		if (!json) {
			return async_error();
		}

		for (var i in json) {
			if ("success" in json[i] && !json[i].success) {
				return async_error(json[i]);
			}
		}

		perform_callbacks(json);
		if (async_current && async_current.callback) {
			async_current.callback(json);
		}

		var draw_slow = false;
		if (
			(async_current && async_current.action == "album") ||
			async_current.action == "artist" ||
			async_current.action == "group"
		) {
			self.draw_latencies.push(new Date() - async_current.start);
			avg = 0;
			while (self.draw_latencies.length > 10) {
				self.draw_latencies.shift();
			}
			for (i = 0; i < self.draw_latencies.length; i++) {
				avg += self.draw_latencies[i];
			}
			avg = avg / self.draw_latencies.length;
			if (avg > slow_draw_threshold) {
				draw_slow = true;
			}
		}
		self.is_slow = draw_slow || net_slow;

		async_current = null;
		self.async_get();
	};

	self.async_get = function(action, params, callback, error_callback) {
		if (action) {
			if (!params) params = {};
			async_queue.push({
				action: action,
				params: params,
				callback: callback,
				error_callback: error_callback,
				start: new Date()
			});
		}
		if (async.readyState === 0 || async.readyState === 4) {
			async_current = async_queue.shift();
			if (async_current) {
				self.last_action = { action: async_current.action, params: async_current.params };
				async.open("POST", url + async_current.action, true);
				async.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
				if (!async_current.params.sid) async_current.params.sid = sid;
				async_current.params.user_id = user_id;
				async_current.params.key = api_key;
				async.send(self.serialize(async_current.params));
			}
		}
	};

	self.async_status = function() {
		console.log("XHR:            ", async);
		console.log("ReadyState:     ", async.readyState);
		console.log("Queue:          ", async_queue);
		console.log("Current action: ", async_current);
		console.log("Last action:    ", self.last_action);
		console.log("Net latency:    ", self.net_latencies);
		console.log("Total latency:  ", self.draw_latencies);
		console.log("Slow:           ", self.is_slow);
		console.log("Station paused: ", self.paused);
	};

	var perform_callbacks = function(json) {
		var cb, key;
		for (key in json) {
			if (key in callbacks) {
				for (cb = 0; cb < callbacks[key].length; cb++) {
					callbacks[key][cb](json[key]);
				}
			}
		}
	};

	self.add_callback = function(api_name, js_func) {
		if (!callbacks[api_name]) callbacks[api_name] = [];
		callbacks[api_name].push(js_func);
	};

	return self;
})();
