from django.http import JsonResponse
from .models import Video
from datetime import datetime
from datetime import timedelta
from datetime import time
from pprint import pprint

tzmap = {
    'EDT': -4,
    'CDT': -5,
    'JST': 9,
    'CEST': 2,
    'BST': 1,
    'MSD': 4,
    'EEST': 3,
    'CST': 8,
    'ADT': -3
}


def index(request):
    data = list(
        Video.objects.values()
        .filter(start_date__day=11)
        .order_by('start_date')
    )

    new_videos = []

    for vid in data:
        add_time_delta = tzmap[vid['tz']] + 4

        vid['start_date'] = vid['start_date'] + timedelta(hours=add_time_delta)
        vid['end_date'] = vid['end_date'] + timedelta(hours=add_time_delta)

        vid['start'] = '{0}:{1}:59'.format(vid['start_date'].hour, vid['start_date'].minute)
        vid['end'] = '{0}:{1}:59'.format(vid['end_date'].hour, vid['end_date'].minute)

        new_videos.append(vid)

    return JsonResponse(new_videos, safe=False)
