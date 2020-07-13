// Avoid `console` errors in browsers that lack a console.
(function () {
  var method;
  var noop = function () { };
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

function setTimeAllPlayers() {
  $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
    $(this).get(0).currentTime = setPlayerTime(this);
  });
}

function isPlaying(playerId) {
  var player = document.getElementById(playerId);
  return !player.paused && !player.ended && 0 < player.currentTime;
}

function pauseAllPlayers() {
  $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
    promise = $(this).get(0).pause();
  });
}

function playAllPlayers() {
  $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
    promise = $(this).get(0).play();
  });
}

function muteAllPlayers() {
  $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
    $(this).prop('muted', true);
  });
}

function setPlayerTime(player) {
  var dataItem = window.data.find(data => data.vidid === player.id);
  return johng.timestamp() - hmsToSeconds(dataItem.start) + dataItem.jump;
}

// Helper function to convert HH:MM:SS to Seconds
function hmsToSeconds(hmsString) {
  var a = hmsString.split(':'); // split it at the colons

  // minutes are worth 60 seconds. Hours are worth 60 minutes.
  var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);

  return seconds;
}

// Jump to the right timestamp
function jumpIt(timeString) {
  timekeeper.currentTime = hmsToSeconds(timeString)
}

function getCurrentTime(timeString) {
  a = (new Date).clearTime().addSeconds(timekeeper.currentTime).toString('h:mm:ss tt');
  return a;
}


// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
  console.log(baseremoteurl + "?" + $("#filters").serialize());
  return baseremoteurl + "?" + $("#filters").serialize();
}

// This function actually gets the data from an AJAX connection and returns it as JSON
function getData() {
  var result;
  $.ajax({
    type: 'GET',
    url: getURL(),
    dataType: 'json',
    async: false,
    cache: true,
    success: function (data) {
      result = data;
    }
  });
  // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
  return result;
};

function updateData() {
  window.data = getData();
  johng.all_data(window.data);
  $('#timekeeper').trigger('pause')
}

function preloadAudioFile(url) {
    a = $('<audio />')
    .attr('src', url)
    .attr('preload', '')
    .attr('muted', 'muted')
    .css('display', 'none')
    .addClass('handsoff')
    .appendTo('body');
};

function formatTime(date) {
  date = Date.parse(date)
  var hours = date.getHours();
  var minutes = date.getMinutes();
  var ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  minutes = minutes < 10 ? '0' + minutes : minutes;
  var strTime = hours + ':' + minutes + ' ' + ampm;
  return (strTime)
}


function addTimelineListeners() {
  // Attach the media timeline to an HTML5 player
  // The player will control the current 'time' of the sim
  var timekeeper = $('#timekeeper').get(0);
  timekeeper.setAttribute("autoplay", "false");

  // When the timkekeeper is loaded, jump to the start point,
  // load the videos and then pause, ready for play.
  $('#timekeeper').on('loadeddata', function () {
    jumpIt(start);
    $(this).trigger('pause')
    setTimeAllPlayers();
    muteAllPlayers();
    pauseAllPlayers();
  });

  // Events for the main timeline controller
  // When the timeline is seeked, then update the play location of the child video players
  timekeeper.addEventListener('seeked', function () {
    setTimeAllPlayers();
  }, false);

  // When the timeline controller is playing, make sure the child video players are running
  timekeeper.addEventListener('play', function () {
    setTimeAllPlayers();
    playAllPlayers();
  }, false);

  // When the timeline controller is paused, make sure the child video players also pause
  timekeeper.addEventListener('pause', function () {
    pauseAllPlayers();
    setTimeAllPlayers();
  }, false);
}

function removeItems(currentItemsList, activeItemsList) {
  // Show which players should be removed
  let removePlayers = currentItemsList.filter(x => !activeItemsList.includes(x));

  // And remove them
  if (Array.isArray(removePlayers)) {
    // We have some players that are no longer live and should be destroyed.
    removePlayers.forEach(
      function (playerId) {
        if (playerId) {
          document.getElementById(playerId + "_div").remove();
        }
      })
  }
};

function addPlayer(playerId, url, source, media_type, format, controls, mute, autoplay, preload) {
  var newPlayer = $('<' + dataItem.media_type + ' />', {
    id: playerId,
    src: dataItem.url,
    type: dataItem.media_type + '/' + dataItem.format,
    controls: show_controls,
    muted: mute_element,
    autoplay: false,
    preload: 'auto',
  });

  var newPlayerTitle = $('<h2 />')
    .attr("id", playerId + '_title')
    .text(dataItem.source);
}

function unmuteAudioPlayers() {
  $("audio").prop('muted', false);
}

function muteAudioPlayers() {
  $("audio").prop('muted', false);
}

function convert12Hto24H(stringTimeInput) {
  stringTime = $.trim(stringTimeInput)
  const [time, modifier] = stringTime.split(' ');
  let [hours, minutes, seconds] = time.split(':');
  if (seconds === undefined) {
    seconds = "00";
  }

  if (hours === '12') {
    hours = '00';
  }

  if (modifier === 'PM') {
    hours = parseInt(hours, 10) + 12;
  }

  return `${hours}:${minutes}:${seconds}`;
}


// Place any jQuery/helper plugins in here.

$(".nav-link").click(function () {
  jumpIt(moment($(this).children().text(), ["h:mm A"]).format("HH:mm:ss"));
});

$("#playButton").on("click", function () {
  unmuteAudioPlayers();
  $("#timekeeper").trigger('play');
});

$("#pauseButton").on("click", function () {
  $("#timekeeper").trigger('pause');
});

$('.nav-link').on("click", function () {
  pauseAllPlayers();
  jumpIt(convert12Hto24H(this.text));
})

$('.ffrw').on("click", function () {
  var timekeeper = $('#timekeeper').get(0);
  timekeeper.currentTime = timekeeper.currentTime + $(this).data("skip");
});
