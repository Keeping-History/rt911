// Avoid `console` errors in browsers that lack a console.
(function() {
  var method;
  var noop = function () {};
  var methods = [
    'assert', 'clear', 'count', 'debug', 'dir', 'dirxml', 'error',
    'exception', 'group', 'groupCollapsed', 'groupEnd', 'info', 'log',
    'markTimeline', 'profile', 'profileEnd', 'table', 'time', 'timeEnd',
    'timeline', 'timelineEnd', 'timeStamp', 'trace', 'warn'
  ];
  var length = methods.length;
  var console = (window.console = window.console || {});

  while (length--) {
    method = methods[length];

    // Only stub undefined methods.
    if (!console[method]) {
      console[method] = noop;
    }
  }
}());

function isPlaying(playerId) {
  var player = document.getElementById(playerId);
  return !player.paused && !player.ended && 0 < player.currentTime;
}

function pause_all_players() {
  $("video, audio:not(#timekeeper").each(function () {
    $(this).get(0).pause();
  });
}

function set_player_time(dataItem) {
  console.log($('#' + dataItem.vidid));
  $('#' + dataItem.vidid).get(0).currentTime = johng.timestamp() - hmsToSeconds(dataItem.start) + dataItem.jump;
}

// Place any jQuery/helper plugins in here.
