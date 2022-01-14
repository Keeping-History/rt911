from datetime import datetime, timedelta, time
import hashlib

from django.http import JsonResponse
from django.db.models import Q
from .models import Media, Tag, TagType, Collection, Marker

# Map timezones to their UTC numerical difference
timezone_map = {
    'ADT': -3,
    'BST': 1,
    'CDT': -3,
    'CEST': 2,
    'CST': 8,
    'EDT': -4,
    'EEST': 3,
    'EST': -4,
    'ET': -4,
    'JST': 9,
    'MDT': -6,
    'MSD': 4,
    'PDT': -7,
    'UTC': 0
}

def mediaType(format):

    mediaTypes = {
        'audio': set(['mp3', 'aac', 'ogg', 'flac', 'webm', 'wav']),
        'video': set(['h.264', 'mp4', 'mov', 'mpg', 'webm', 'ogg', 'm3u8', 'm3u']),
        'html': set(['html']),
        'iframe': set(['iframe']),
        'image': set(['jpg', 'png', 'gif']),
    }

    for mediaType in mediaTypes:
        if format in mediaTypes[mediaType]:
            return mediaType

    return format

def index(request):

    # Create an array to hold our query filters
    q = Q()

    # Is the request a GET type?
    if request.method == 'GET':
        # If URL params are set, create the approrpriate Q query filter
        if 'day' in request.GET:
            q &= Q(start_date__day=request.GET['day'])
        if 'network' in request.GET:
            if request.GET['network'] != 'all':
                q &= Q(source__in=request.GET.getlist('network'))
        if 'year' in request.GET:
            q &= Q(start_date__year=request.GET['year'])
        if 'month' in request.GET:
            q &= Q(start_date__month=request.GET['month'])
        # TODO: Need to get mediaType instead of format.
        if 'format' in request.GET:
            if request.GET['format'] != 'all':
                q &= Q(format__in=request.GET.getlist('format'))
        if 'collection' in request.GET:
            if request.GET['collection'] != 'all':
                q &= Q(collection__in=request.GET.getlist('collection'))

        q &= Q(approved=True)

    # Activate our (lazy) filters and get the actual data
    data = list(
        Media.objects.values()
        .filter(q)
        .order_by('sort', 'start_date')
    )


    # Create a holder for our view output
    new_media = []

    for media_item in data:

        media_item['media_type'] = mediaType(media_item['format'])

        media_item['duration'] = int((media_item['end_date'] - media_item['start_date']).total_seconds() - media_item['jump']  - media_item['trim'])

        add_time_delta = 0 # convert UTC to Eastern Standard Time

        media_item['start_date'] = media_item['start_date'] + timedelta(hours=add_time_delta)
        media_item['end_date'] = media_item['end_date'] + timedelta(hours=add_time_delta)

        media_item['start'] = media_item['start_date'].hour*3600 + media_item['start_date'].minute * 60 + media_item['start_date'].second
        media_item['end'] = media_item['start'] + media_item['duration']
        media_item['vidid'] = 'm' + hashlib.md5(media_item['url'].encode("utf-8")).hexdigest()
        new_media.append(media_item)

    return JsonResponse(new_media, safe=False)


def networks(request):

    # Activate our (lazy) filters and get the actual data
    data = list(
        Media.objects.values()
    )

   # Create a holder for our view output
    networks = []

    for item in data:
        networks.append(item['source'])

    return JsonResponse(list(dict.fromkeys(networks)), safe=False)


def formats(request):

    # Activate our (lazy) filters and get the actual data
    data = list(
        Media.objects.values()
    )

   # Create a holder for our view output
    formats = []

    for item in data:
        formats.append(item['format'])

    return JsonResponse(list(dict.fromkeys(formats)), safe=False)


def tags(request):

    # Activate our (lazy) filters and get the actual data
    data = list(
        Tag.objects.values()
    )

   # Create a holder for our view output
    tags = []

    for item in data:
        tags.append(item['description'])

    return JsonResponse(list(dict.fromkeys(tags)), safe=False)


def tag_types(request):

    # Activate our (lazy) filters and get the actual data
    data = list(
        TagType.objects.values()
    )

   # Create a holder for our view output
    tag_types = []

    for item in data:
        tag_types.append(item['name'])

    return JsonResponse(list(dict.fromkeys(tag_types)), safe=False)


def collections(request):

    # Activate our (lazy) filters and get the actual data
    data = list(
        Collection.objects.values()
    )

   # Create a holder for our view output
    collections = []

    for item in data:
        collections.append(item['name'])

    return JsonResponse(list(dict.fromkeys(collections)), safe=False)

def markers(request):

    # Activate our (lazy) filters and get the actual data
    q = Q(approved=True)

    data = list(
        Marker.objects.values()
        .filter(q)
        .order_by('time_marker')
    )

    # Create a holder for our view output
    markers = []

    for item in data:
        marker = {}
        marker['name'] = item['name']
        marker['id'] = item['id']
        marker['time_marker'] = item['time_marker'].strftime("%-I:%M:%S %p")
        markers.append(marker)

    return JsonResponse(list(markers), safe=False)
