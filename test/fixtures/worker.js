// Dedicated worker fixture. Emits on demand so tests can drive worker console
// output, uncaught errors, and unhandled promise rejections after the CDP
// session has attached (avoiding any reliance on replay of pre-attach output).
console.log("[TEST] worker started");

self.onmessage = e => {
  const d = String(e.data || "");
  if (d.startsWith("log:")) {
    console.log("[TEST] worker-log " + d.slice(4));
  } else if (d.startsWith("error:")) {
    throw new Error("[TEST] worker-error " + d.slice(6));
  } else if (d.startsWith("reject:")) {
    Promise.reject(new Error("[TEST] worker-reject " + d.slice(7)));
  } else {
    self.postMessage("echo:" + d);
  }
};
