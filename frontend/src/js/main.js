// The 9/11RT controller
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Eastern Time, and runs to 11:59:59 PM the same day.
//

// Global Vars
// baseRemoteURL: The base URL for the API
//
// timeDrift: don't change the current video's time unless it is this
// many seconds out of sync
//
// playerSync: determines how quickly after the counter is stopped
// should audios and videos be checked to stop as well
//
// preloadBuffer: determines a threshold for whether
// or not a file should be preloaded. This is based
// on whether it would make a significant difference
//
// preloadCutoff: files that are longer than this
// (in seconds) should not be preloaded
//
// preloadFormats: the media formats that should be pre-loaded. Currently
// only Audio. Videos are not recommended at this time.
//
// audioControls, videoControls: an array of the controls that each
// type of media player should display. See
// https://github.com/sampotts/plyr/blob/master/CONTROLS.md
//

const baseRemoteURL = '//admin.911realtime.org/media/'
const timeDrift = 15 // seconds
const playerSync = 3 // seconds
const preloadBuffer = 120 // seconds
const preloadCutoff = 120 // seconds
const preloadFormats = ['audio']
const audioControls = [
  'current-time',
  'duration',
  'mute',
  'volume'
]
const videoControls = [
  'current-time',
  'airplay',
  'fullscreen',
  'volume',
  'airplay'
]

// Global Modal holder object
const globalModals = []

// Global Media Player holder object
const plyrPlayers = {}

// Create our controller instance
const controller = new JohnG(0, 1, true, false, '.timeText')

// Preload data to improve performance
// During build time, cache json data is added as a variable to increase
// load time. If these are empty, they will be populated from an AJAX
// call on load.

// Caching and preload Functions
// Function that creates a media object and pre-loads its data
function preloadMediaFile (mediaType, url, id) {
  if (!jQuery(`#${id}_preload`).length) {
    jQuery(`<${mediaType} />`)
      .attr('src', url)
      .attr('id', `${id}_preload`)
      .attr('preload', true)
      .attr('autoplay', false)
      .attr('muted', true)
      .css('display', 'none')
      .addClass('hands-off')
      .appendTo('#preloadContainer')
  }
}

// Utility function to preload all needed players
function preloadPlayers (data) {
  if (!$('#preloadContainer').length) {
    jQuery('<div>', {
      id: 'preloadContainer'
    }).appendTo('body')
  }

  if (data !== undefined || data.length > 0) {
    data.forEach(async (item) => {
      if (
        preloadFormats.includes(item.media_type) &&
        item.start - preloadBuffer < controller.count &&
        item.end - preloadBuffer > controller.count &&
        item.end - item.start < preloadCutoff
      ) {
        preloadMediaFile(item.media_type, item.url, item.vidid)
      }
    })
  }
}

// Audio Control
function muteAllPlayers () {
  jQuery('video:not(.hands-off), audio:not(.hands-off)').each(function muteThisPlayer () {
    jQuery(this).prop('muted', true)
  })
}

function muteAudioPlayers () {
  jQuery('audio:not(.hands-off)').prop('muted', true)
}

function unmuteAudioPlayers () {
  jQuery('audio:not(.hands-off)').prop('muted', false)
}

// Playback Control
function pauseAllPlayers () {
  jQuery('video:not(.hands-off), audio:not(.hands-off)').each(function () {
    jQuery(this).get(0).pause()
  })
}

function playAllPlayers () {
  jQuery('video:not(.hands-off), audio:not(.hands-off)').each(function () {
    if (jQuery(this).get(0).paused) {
      jQuery(this).get(0).play()
    }
  })
}

// Time Functions
function getPlayerTime (playerId) {
  const dataItem = controller.all().find((jsonData) => jsonData.vidid === playerId)
  return controller.current() - dataItem.start + dataItem.jump
}

async function setTimeAllPlayers (sync = false) {
  jQuery('video:not(.hands-off), audio:not(.hands-off)').each(function () {
    if (
      (Math.abs(getPlayerTime(this.id) - jQuery(this).get(0).currentTime) >
        timeDrift) || sync === true
    ) {
      jQuery(this).get(0).currentTime = getPlayerTime(this.id)
    }
  })
}

// Format a date in pretty format
function dateFormatter (d) {
  let hours = d.getHours()
  let minutes = d.getMinutes()
  let seconds = d.getSeconds()
  if (!this.clock24hour) {
    const period = hours >= 12 ? 'PM' : 'AM'
    hours %= 12
    hours = hours || 12 // the hour '0' should be '12'
    return `${hours}:${minutes}:${seconds} ${period}`
  }
  minutes = minutes < 10 ? `0${minutes}` : minutes
  seconds = seconds < 10 ? `0${seconds}` : seconds
  return `${hours}:${minutes}:${seconds}`
}

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getAPIURL () {
  return (
    `${baseRemoteURL}?${jQuery('#filters :input[value!=\'all\']').serialize()}`
  )
}

// Grabs the data via ajax
function getData () {
  if (window.dataCache.length > 0) {
    return window.dataCache
  }
  $.ajax({
    type: 'GET',
    url: getAPIURL(),
    dataType: 'json',
    async: false,
    cache: true,
    success (data) {
      if (data.length > 0) {
        window.dataCache = data
      } else {
        window.dataCache = ['No Items Found']
      }
    }
  })
  return window.dataCache
}

// Grabs the list of networks via ajax
function updateNetworks () {
  if (window.networkListCache.length > 0) {
    window.networkListCache.forEach((item) => {
      jQuery('#network').append(
        jQuery('<option>').text(item).attr('value', item)
      )
    })
  } else {
    $.ajax({
      type: 'GET',
      url: `${baseRemoteURL}networks`,
      dataType: 'json',
      async: true,
      cache: true,
      success (data) {
        window.networkListCache = data
        data.forEach((item) => {
          jQuery('#network').append(
            jQuery('<option>').text(item).attr('value', item)
          )
        })
      }
    })
  }
}

// Grabs the list of available time markers via ajax
async function updateMarkers () {
  if (window.markerListCache.length > 0) {
    window.markerListCache.forEach((item) => {
      if (jQuery(`#events ul #${item.id}`).length === 0) {
        jQuery(
          `<li id=${item.id
          }><b><a href="#" class="time-marker">${item.time_marker
          }</a></b>${item.name
          }</li>`
        ).appendTo('#events ul')
      }
    })
  } else {
    $.ajax({
      type: 'GET',
      url: `${baseRemoteURL}markers`,
      dataType: 'json',
      async: true,
      cache: true,
      success (data) {
        window.markerListCache = data
        data.forEach((item) => {
          if (jQuery(`#events ul #${item.id}`).length === 0) {
            jQuery(
              `<li id=${item.id
              }><b><a href="#" class="time-marker">${item.time_marker
              }</a></b>${item.name
              }</li>`
            ).appendTo('#events ul')
          }
        })
      }
    })
  }
  jQuery('.time-marker').on('click', function () {
    jumpToTime(this.text)
    controller.updateClock()
    controller.play()
  })
}

function invalidateLocalDataCache () {
  window.dataCache = []
  window.markerListCache = []
  window.networkListCache = []
}

// Get fresh data: clear out cache and make a new call
function refreshData () {
  invalidateLocalDataCache()
  updateAllData()
}

function updateAllData () {
  updateMarkers()
  updateNetworks()
  updateData()
}

// Update the media data
function updateData () {
  controller.set(getData())
}

// Convert Hours:Minutes:Seconds to just seconds
function hmsToSeconds (hmsString) {
  const a = hmsString.split(':')
  const seconds = +a[0] * 60 * 60 + +a[1] * 60 + +a[2]
  return seconds
}

function removeItems (removeMediaItems) {
  if (Array.isArray(removeMediaItems)) {
    // We have some players that are no longer live and should be destroyed.
    removeMediaItems.forEach((playerId) => {
      if (playerId) {
        if (plyrPlayers[playerId]) {
          jQuery(`#${playerId}`)[0].pause()
          jQuery(`#${playerId}`)[0].currentSrc = null
          jQuery(`#${playerId}`)[0].src = ''
          jQuery(`#${playerId}`)[0].removeAttribute('src') // empty source
          jQuery(`#${playerId}`)[0].srcObject = null
          jQuery(`#${playerId}`)[0].load()
          plyrPlayers[playerId].destroy()
          delete jQuery(`#${playerId}`)
        }

        jQuery(`#${playerId}_div`)
          .empty()
          .remove()
        jQuery(`#${playerId}_preload`)
          .empty()
          .remove()
      }
    })
  }
}

function addItems (addMediaItems) {
  // And add them
  if (Array.isArray(addMediaItems)) {
    // Ok, so addMediaItems is an actual Array, so we can loop over it
    addMediaItems.forEach((playerId) => {
      // Does a player window with the same ID already exist?
      const doesPlayerExist = document.getElementById(playerId)

      if (!doesPlayerExist) {
        // Grab the video's data item because we will need it
        const mediaItem = controller
          .all()
          .find((data) => data.vidid === playerId)

        switch (mediaItem.media_type) {
          case 'video':
            // Add video to the holder
            jQuery('#videos').append(
              createVideo(playerId, mediaItem)
            )

            // Create a new Plyr instance for the video
            plyrPlayers[playerId] = new Plyr(`#${playerId}`, {
              controls: videoControls,
              clickToPlay: false
            })

            // Set the volume to the correct value
            jQuery(`#${playerId}`).prop(
              'volume',
              jQuery(`#${playerId}`).attr('media_volume')
            )

            // Mute the video, as it only plays audio when expanded
            jQuery(`#${playerId}`).prop('muted', true)

            // When clicking a player, make it the main player,
            jQuery(
              `#${playerId
              }_div div.plyr div:not(.plyr__controls, .plyr__controls *)`
            ).click(() => {
              jQuery(`#${mediaItem.media_type}PlayerMain`)
                .children()
                .prependTo(`#${mediaItem.media_type}s`)
              jQuery(`#${playerId}`).prop(
                'muted',
                jQuery(`#${playerId}`).attr('muted')
              )
              if (
                jQuery(`#${playerId}_div`).hasClass(
                  'highlight'
                )
              ) {
                jQuery('div').removeClass('highlight')
                jQuery(`#${playerId}`).prop('muted', true)
              } else {
                jQuery('div').removeClass('highlight')
                jQuery(`#${mediaItem.media_type}s`)
                  .find(mediaItem.media_type)
                  .prop('muted', true)
                jQuery(`#${playerId}_div`)
                  .prependTo(
                    `#${mediaItem.media_type
                    }PlayerMain`
                  )
                  .addClass('highlight')
                jQuery(`#${playerId}`).prop('muted', false)
              }
              return false
            })

            // ENABLE HLS
            if (mediaItem.format === 'm3u8') {
              if (Hls.isSupported()) {
                const video = document.getElementById(playerId)
                const hls = new Hls({ debug: false })
                // Bind the vide and the HLS plugin together
                hls.attachMedia(video)
                hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                  hls.loadSource(mediaItem.url)
                  hls.on(
                    Hls.Events.ERROR,
                    (event, data) => {
                      if (data.fatal) {
                        switch (data.type) {
                          case Hls.ErrorTypes
                            .NETWORK_ERROR:
                            // try to recover network error
                            console.info(
                              'HLS: fatal network error encountered, try to recover'
                            )
                            hls.startLoad()
                            break
                          case Hls.ErrorTypes
                            .MEDIA_ERROR:
                            console.info(
                              'HLS: fatal media error encountered, try to recover'
                            )
                            hls.recoverMediaError()
                            break
                          default:
                            // cannot recover
                            hls.destroy()
                            break
                        }
                      }
                    }
                  )
                })
              }
            }

            break

          case 'audio':

            // Add audio to the holder
            jQuery('#audios').append(
              createAudio(playerId, mediaItem)
            )

            plyrPlayers[playerId] = new Plyr(`#${playerId}`, {
              controls: audioControls
            })

            // Set the volume to the correct value
            jQuery(`#${playerId}`).prop(
              'volume',
              jQuery(`#${playerId}`).attr('media_volume')
            )

            // Only allow the audio player to unmute when the master mute
            // button is unchecked
            jQuery(`#${playerId}`).prop(
              'muted',
              !jQuery('#mute_all_audio').is(':checked')
            )
            jQuery(`#${playerId}`).currentTime = controller.current() - mediaItem.start + mediaItem.jump

            // Start playback of the video file
            jQuery(`#${playerId}`).trigger('play')

            // Ensure that when the video is done playing, it is removed
            jQuery(`#${playerId}`).bind(
              'ended',
              (playerId) => {
                removeItems([playerId])
              }
            )
            break

          case 'modal':
            if (mediaItem.end > controller.current() && !jQuery('#bootModal').is(':visible')) {
              if (
                jQuery.inArray(
                  mediaItem.vidid,
                  globalModals
                ) === -1
              ) {
                jQuery('#modal-title').text(mediaItem.source)
                jQuery('#modal-time').text(mediaItem.start)

                if (mediaItem.image !== '') {
                  jQuery('#modal-image').attr(
                    'src',
                    mediaItem.image
                  )
                  jQuery('#modal-image').attr(
                    'alt',
                    mediaItem.image_caption
                  )
                  if (mediaItem.image_caption !== '') {
                    jQuery('#modal-image-caption').html(
                      mediaItem.image_caption
                    )
                  }
                }

                jQuery('#modal-full-title').text(
                  mediaItem.title
                )
                jQuery('#modal-content').html(
                  mediaItem.content
                )
                jQuery('#modalModal').modal({
                  backdrop: false,
                  show: true,
                  showClose: false,
                  closeExisting: false,
                  fadeDuration: 100,
                  clickClose: false,
                  blockerClass: 'blocker'
                })
                globalModals.push(mediaItem.vidid)
                controller.pause()
              }
            }
            break
          default:
            jQuery('#htmls').append(
              createHTML(playerId, mediaItem)
            )
            break
        }
        if (mediaItem.media_type !== 'modal') {
          // Add video object and title we just created to DOM
          jQuery(`#${playerId}_div`).prependTo(
            `#${mediaItem.media_type}s`
          )
        }
      }
    })
  }
}

function createAudio (playerId, mediaItem) {
  const audioItem = {
    PlayerID: playerId,
    AudioURL: mediaItem.url,
    Volume: mediaItem.volume,
    Type: mediaItem.type,
    Title: `${mediaItem.source} - ${mediaItem.title}`
  }

  const template = document.getElementById('audio_player_template').innerHTML
  return $.parseHTML($.trim(Mustache.render(template, audioItem)))
}

function createHTML (playerId, mediaItem) {
  const htmlItem = {
    ItemID: playerId,
    Time: dateFormatter(Date.parse(mediaItem.start_date)),
    Title: mediaItem.title,
    ImageURL: mediaItem.image,
    Content: mediaItem.content
  }

  const template = document.getElementById('html_item_template').innerHTML
  return $.parseHTML($.trim(Mustache.render(template, htmlItem)))
}

function createVideo (playerId, mediaItem) {
  const videoItem = {
    PlayerID: playerId,
    VideoURL: mediaItem.url,
    Type: mediaItem.type,
    Source: mediaItem.source,
    StartTime: mediaItem.startTime,
    Volume: mediaItem.volume
  }

  const template = document.getElementById('video_item_template').innerHTML
  return $.parseHTML($.trim(Mustache.render(template, videoItem)))
}

// A helper function that's not currently used.
function isMediaReady () {
  const currentData = controller.get()
  currentData.forEach((element) => {
    if (element.media_type === 'video') {
      jQuery(`#${element.vidid}`).on('canplay', () => {
        // console.log("canplay: ", element);
      })
    }
  })
}

function moveTime (increment) {
  controller.move(increment)
  setTimeAllPlayers()
}

// Jump to the right timestamp
async function jumpToTime (stringTimeInput) {
  const stringTime = $.trim(stringTimeInput)
  const [time, modifier] = stringTime.split(' ')
  let [hours, minutes, seconds] = time.split(':')

  if (seconds === undefined) {
    seconds = '00'
  }
  if (hours === '12') {
    hours = '00'
  }
  if (modifier.toUpperCase() === 'PM') {
    hours = parseInt(hours, 10) + 12
  }

  controller.setCurrent(hmsToSeconds(`${hours}:${minutes}:${seconds}`))
  controller.updateClock()
  controller.pause()
  setTimeAllPlayers()
}

// Setup things when the document is ready
jQuery(() => {
  jQuery('.close-modal-boot-button, #hider').on('click', (event) => {
    jQuery('#hider').hide()
    $.modal.close()
    jQuery('#sound_boot').trigger('play')
    controller.play()
    muteAllPlayers()
  })

  jQuery('.close-modal-button').on('click', () => {
    $.modal.close()
    controller.play()
  })

  jQuery('#playButton').on('click', () => {
    controller.play()
  })

  jQuery('#syncButton').on('click', () => {
    setTimeAllPlayers()
  })

  jQuery('#loadButton').on('click', () => {
    setTimeAllPlayers()
  })

  jQuery('#pauseButton').on('click', () => {
    controller.pause()
  })

  jQuery('.ffrw').on('click', function () {
    moveTime(parseInt(jQuery(this).data('skip')))
  })

  jQuery('#mute_all_audio').on('click', function () {
    if (jQuery(this).is(':checked')) {
      // unmuteAudioPlayers();
      jQuery('#radio_mute_icon').attr('src', '../img/sound_on.png')
    } else {
      muteAudioPlayers()
      jQuery('#radio_mute_icon').attr('src', '../img/sound_off.png')
    }
  })

  // If updating form fields, add their changes to the URL
  jQuery('#filters input').on('click', refreshData)
  jQuery('#filters select').on('change', refreshData)
  jQuery('#backgroundSetting').on('change', function () {
    jQuery('body, html').css(
      'background-image',
      encodeURI(
        `url('../img/${jQuery(this).children(':selected').attr('id')
        }')`
      )
    )
  })

  // Make sure the child players are always paused when the timeline player is also paused
  window.setInterval(() => {
    if (!controller.isPlaying()) {
      pauseAllPlayers()
      setTimeAllPlayers()
    }
  }, playerSync * 1000)

  window.setInterval(() => {
    if (controller.isPlaying()) {
      playAllPlayers()
      setTimeAllPlayers()
    }
  }, playerSync * 1000)

  jQuery('#menu-play').on('click', () => {
    controller.play()
  })

  jQuery('#menu-pause').on('click', () => {
    controller.pause()
  })

  jQuery('#jumpItButton').click(() => {
    let jumpHour = jQuery('#jumpItHour').val()
    let jumpMinute = jQuery('#jumpItMinute').val()
    let jumpSecond = jQuery('#jumpItSecond').val()
    const jumpPeriod = jQuery('#jumpItPeriod').val()

    if (jumpHour === '') {
      jumpHour = '00'
    }
    if (jumpMinute === '') {
      jumpMinute = '00'
    }
    if (jumpSecond === '') {
      jumpSecond = '00'
    }

    jQuery('#jumpItHour').val(jumpHour)
    jQuery('#jumpItMinute').val(jumpMinute)
    jQuery('#jumpItSecond').val(jumpSecond)
    jQuery('#jumpItPeriod').val(jumpPeriod)

    jumpToTime(
      `${jumpHour}:${jumpMinute}:${jumpSecond} ${jumpPeriod}`
    )
    controller.play()
  })

  // Every time the media player's time changes, this function weill be called
  // This is our main running function
  controller.tickFunction = function () {
    // Set some variables
    const activeItems = controller.get()
    let currentItemsList = []
    let activeItemsList = []
    let currentItems = []

    // We slice the currentItems list so we can have an Array
    // instead of an HTMLCollection.
    currentItems = Array.prototype.slice.call(
      document.querySelectorAll(
        'div.htmlItem, video:not(.hands-off), audio:not(.hands-off)'
      )
    )

    // The activeItems is passed in to the function each time it is run
    activeItemsList = activeItems.map((activeItem) => activeItem.vidid)

    // Current items are those currently on the page
    currentItemsList = currentItems.map((currentItem) => currentItem.id)

    // Subtract current and active items to determine which items are new, not
    // currently on the page and should be added, and as well trigger items that
    // are no longer active to deactivate.
    const addMediaItems = activeItemsList.filter(
      (x) => !currentItemsList.includes(x)
    )
    const removeMediaItems = currentItemsList.filter(
      (x) => !activeItemsList.includes(x)
    )

    // Add New Items to the page that don't already exist and apply preload rules
    addItems(addMediaItems)

    // Preload media items that will benefit from it (short audio clips, for example)
    preloadPlayers(getData())

    // Remove old items from the page that aren't currently active
    removeItems(removeMediaItems)
  }

  jQuery('#bootModal').modal({
    backdrop: false,
    show: true,
    showClose: false,
    closeExisting: false,
    fadeDuration: 100,
    clickClose: false,
    blockerClass: 'blocker'
  })

  // Every (playerSync) seconds, sync the video players' time with the controller counter
  setTimeout(() => {
    controller.tickFunction()
    setTimeAllPlayers()
  }, playerSync * 1000)

  // Currently, we are defaulting to 8:13:30 AM ET.
  // TODO: Add a button to home modal that allows you to change the time to now/a marker time
  jumpToTime('08:13:30 AM')

  updateAllData()
  muteAudioPlayers()

  setTimeAllPlayers()
})
