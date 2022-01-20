jQuery(function () {
  const interfaceAudioPlayer = new Audio()

  function playInterfaceSound (sound) {
    const sounds = {
      boot: '../resources/boot.mp3',
      close: '../resources/close.mp3',
      menu: '../resources/menu.mp3',
      moveStop: '../resources/move-stop.mp3',
      open: '../resources/open.mp3',
      windowCollapse: '../resources/window-collapse.mp3',
      windowExpand: '../resources/window-expand.mp3'
    }

    if (sound in sounds) {
      interfaceAudioPlayer.src = sounds[sound]
      interfaceAudioPlayer.play()
    }
  }

  // Helper function to decide if browser is mobile or not
  function isMobile () {
    try {
      document.createEvent('TouchEvent')
      return true
    } catch (e) {
      return false
    }
  }

  // Make windows movable and make sure the active window is on top
  jQuery('.draggable-window').draggable({
    handle: 'h1.title',
    start: function () {
      jQuery('.content').css('z-index', '1100')
      jQuery(this).css('z-index', '1200')
    }
  })

  // Make windows resizable
  jQuery('.resizable').resizable({
    handles: 'se',
    stop: function (event, ui) {
      playInterfaceSound('moveStop')
    }
  })

  // Zoom Box -- Make Window Full Screen and toggle back
  jQuery('.zoom-box').on('click', function () {
    const theWindow = this.closest('.content')
    const isWindowMaximized = jQuery(this).data('max')

    if (!isWindowMaximized) {
      jQuery(theWindow)
        .css('width', '99%')
        .css('height', '95%')
        .css('left', '.5rem')
        .css('top', '2.5rem')

      jQuery(this)
        .data('width', jQuery(theWindow).css('width'))
        .data('height', jQuery(theWindow).css('height'))
        .data('top', jQuery(theWindow).css('top'))
        .data('left', jQuery(theWindow).css('left'))
        .data('max', true)
      playInterfaceSound('windowExpand')
    } else {
      jQuery(theWindow).removeAttr('style')
      playInterfaceSound('windowCollapse')

      jQuery(this).data('max', false)
    }
  })

  // Windowshade Box -- Minimize the window to just the title bar
  jQuery('.windowshade-box').on('click', function () {
    const contentBox = jQuery(this).closest('.content')
    contentBox.css('z-index', '1')
    const shadeHeight = jQuery(this).data(
      'shade-height',
      jQuery(this).css('height')
    )
    if (jQuery(this).hasClass('shade')) {
      jQuery(contentBox).children('.inner').removeClass('hidden')
      jQuery(contentBox).children('.ui-resizable-handle').removeClass('hidden')
      jQuery(contentBox).css('height', shadeHeight)
      jQuery(this).removeClass('shade')
      playInterfaceSound('windowExpand')
    } else {
      jQuery(contentBox).children('.inner').addClass('hidden')
      jQuery(contentBox).children('.ui-resizable-handle').addClass('hidden')
      jQuery(contentBox).css('height', '')
      jQuery(this).addClass('shade')
      playInterfaceSound('windowCollapse')
    }
  })

  // Close Box -- Close the window when clicked
  jQuery('.close-box, .close-button').on('click', function () {
    const theWindow = this.closest('.content')
    jQuery(theWindow).addClass('hidden')
    playInterfaceSound('close')
  })

  // Enable Desktop Icons
  if (isMobile()) {
    jQuery('.icon').on('click', function () {
      jQuery('#' + jQuery(this).get(0).id.split('-')[1])
        .removeClass('hidden')
        .css('z-index', '9000')
      playInterfaceSound('open')
    })
  } else {
    jQuery('.draggable-icon').draggable({})
    jQuery('.icon').on('dblclick', function () {
      jQuery('#' + jQuery(this).get(0).id.split('-')[1])
        .removeClass('hidden')
        .css('z-index', '9000')
      playInterfaceSound('open')
    })
  }

  // Make sure the active window is on top
  jQuery('.content').on('click', function () {
    jQuery('.content').css('z-index', '1100')
    jQuery(this).css('z-index', '1200')
  })

  jQuery('#nav-list li').on('click touch', function () {
    jQuery(this).children().show()
  })

  jQuery('#nav-list li').on('mouseleave', function () {
    jQuery(this).children('ul').hide()
  })

  // Enable menu items to be clickable by default and open a windows/app with the same name
  jQuery('#nav-list li ul li').on('click', function () {
    playInterfaceSound('play')
    jQuery('#' + jQuery(this).get(0).id.split('-')[1])
      .removeClass('hidden')
      .css('z-index', '9000')
  })
})
