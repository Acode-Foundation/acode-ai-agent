// Acode system.httpStream fixture, copied without changes to the implementation.
// Retrieved 2026-09-08. Source: https://github.com/Acode-Foundation/Acode/blob/main/src/plugins/system/www/plugin.js
module.exports = {
  httpStream: function (url, options) {
    options = options || {};
    var signal = options.signal || null;

    var nativeOptions = {};
    for (var key in options) {
      if (key !== "signal") nativeOptions[key] = options[key];
    }

    return new Promise(function (resolve, reject) {
      var requestId = "httpStream_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
      var HIGH_WATER_MARK = 65536;
      var controller = null;
      var headersReceived = false;
      var started = false;
      var cancelSent = false;
      var terminal = false;
      var receivedBytes = 0;
      var ackedBytes = 0;

      function sendCancel() {
        if (cancelSent) return;
        cancelSent = true;
        cordova.exec(null, null, "System", "http-stream-cancel", [requestId]);
      }

      function teardownSignal() {
        if (signal) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch (e) {}
        }
      }

      function finish() {
        terminal = true;
        teardownSignal();
      }

      function fail(err) {
        if (terminal) return;
        finish();
        if (headersReceived && controller) {
          controller.error(err);
        } else {
          reject(err);
        }
      }

      function onAbort() {
        if (terminal) return;
        if (started) sendCancel();
        var err = new Error("The http stream was aborted");
        err.name = "AbortError";
        fail(err);
      }

      function ackConsumed() {
        if (terminal || !controller) return;
        var desired = controller.desiredSize;
        if (desired === null) return;
        var buffered = Math.max(0, HIGH_WATER_MARK - desired);
        var consumed = receivedBytes - buffered;
        var delta = consumed - ackedBytes;
        if (delta > 0) {
          ackedBytes = consumed;
          cordova.exec(null, null, "System", "http-stream-ack", [requestId, delta]);
        }
      }

      function headersFromPairs(pairs) {
        var h = new Headers();
        if (!pairs) return h;
        if (!Array.isArray(pairs)) {
          for (var name in pairs) {
            try {
              h.append(name, pairs[name]);
            } catch (e) {}
          }
          return h;
        }
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i];
          if (!pair || pair.length < 2) continue;
          try {
            h.append(pair[0], pair[1]);
          } catch (e) {}
        }
        return h;
      }

      var stream = new ReadableStream(
        {
          start: function (c) {
            controller = c;
          },
          pull: function () {
            ackConsumed();
          },
          cancel: function () {
            finish();
            if (started) sendCancel();
          },
        },
        {
          highWaterMark: HIGH_WATER_MARK,
          size: function (chunk) {
            return chunk.byteLength;
          },
        },
      );

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort);
        }
      }
      if (terminal) return;

      started = true;
      cordova.exec(
        function (event) {
          if (!event || typeof event !== "object" || terminal) return;

          switch (event.type) {
            case "headers": {
              headersReceived = true;
              var status = event.status;
              var cannotHaveBody = status === 204 || status === 205 || status === 304;
              var headers = headersFromPairs(event.headers || []);
              var response;
              if (cannotHaveBody) {
                response = new Response(null, {
                  status: status,
                  statusText: event.statusText || "",
                  headers: headers,
                });
              } else {
                response = new Response(stream, {
                  status: status,
                  statusText: event.statusText || "",
                  headers: headers,
                });
              }
              if (event.url) {
                Object.defineProperty(response, "url", { value: event.url, configurable: true });
              }
              resolve(response);
              break;
            }
            case "data": {
              if (controller && event.chunk) {
                var bytes = event.b64 ? base64ToBytes(event.chunk) : latin1ToBytes(event.chunk);
                controller.enqueue(bytes);
                receivedBytes += bytes.byteLength;
              }
              break;
            }
            case "complete": {
              finish();
              if (controller) controller.close();
              break;
            }
            case "error": {
              fail(new Error(event.message || "Stream failed"));
              break;
            }
          }
        },
        function (err) {
          fail(typeof err === "string" ? new Error(err) : err);
        },
        "System",
        "http-stream-start",
        [requestId, url, nativeOptions],
      );
    });
  },
};

function base64ToBytes(base64) {
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function latin1ToBytes(text) {
  var bytes = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}
