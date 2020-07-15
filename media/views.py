from datetime import datetime, timedelta, time
import hashlib

from django.http import JsonResponse
from django.db.models import Q
from .models import Media

# Map timezones to their UTC numerical difference
timezone_map = {
    'UTC': 0,
    'PDT': -7,
    'MSD': 4,
    'MDT': -6,
    'JST': 9,
    'EEST': 3,
    'EDT': -4,
    'CST': 8,
    'CEST': 2,
    'CDT': -3,
    'BST': 1,
    'ADT': -3,
}

def index(request):

    # Create an array to hold our query filters
    q = Q()

    # Is the request a GET type?
    if request.method == 'GET':

        # If URL params are set, create the approrpriate Q query filter
        if 'day' in request.GET:
            q &= Q(start_date__day=request.GET['day'])
        if 'network' in request.GET:
            if request.GET['network'] != '':
                q &= Q(source=request.GET['network'])
        if 'year' in request.GET:
            q &= Q(start_date__year=request.GET['year'])
        if 'month' in request.GET:
            q &= Q(start_date__month=request.GET['month'])
        if 'format' in request.GET:
            q &= Q(format=request.GET['format'])

    # Activate our (lazy) filters and get the actual data
    data = list(
        Media.objects.values()
        .filter(q)
        .order_by('start_date')
    )


    # Create a holder for our view output
    new_media = []

    for media_item in data:

        media_item['media_type'] =  media_item['format']

        mediaTypes = {
            'video': set(['h.264', 'mp4', 'mov', 'mpg', 'webm', 'ogg']),
            'audio': set(['mp3', 'aac', 'ogg', 'flac', 'webm', 'wav']),
            'html': set(['html']),
            'iframe': set(['iframe']),
            'image': set(['jpg', 'png', 'gif']),
        }
        for mediaType in mediaTypes:
            if media_item['format'] in mediaTypes[mediaType]:
                media_item['media_type'] = mediaType

        media_item['duration'] = int((media_item['end_date'] - media_item['start_date']).total_seconds() - media_item['jump']  - media_item['trim'])

        add_time_delta = timezone_map[media_item['tz']] + 4 # convert UTC to Eastern Standard Time

        media_item['start_date'] = media_item['start_date'] + timedelta(hours=add_time_delta)
        media_item['end_date'] = media_item['end_date'] + timedelta(hours=add_time_delta)

        media_item['start'] = '{0}:{1}:{2}'.format(media_item['start_date'].hour, media_item['start_date'].minute, media_item['start_date'].second)
        media_item['end'] = '{0}:{1}:{2}'.format(media_item['end_date'].hour, media_item['end_date'].minute, media_item['end_date'].second)
        media_item['vidid'] = 'm' + hashlib.md5(media_item['url'].encode("utf-8")).hexdigest()
        new_media.append(media_item)

    return JsonResponse(new_media, safe=False)
