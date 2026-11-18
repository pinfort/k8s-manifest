// Wall display: reload every 6 hours so a long-running Safari tab doesn't grow forever.
setTimeout(function () { location.reload(); }, 6 * 60 * 60 * 1000);
