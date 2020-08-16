import json
import re
import hashlib
from datetime import datetime, timedelta
from bs4 import BeautifulSoup

entries_json = json.load(open('entries_new.json'))
tags_json = json.load(open('tags.json'))

title_matches = ["Before", "After", "Shortly", "Between",
                 "Late", "Early", "and", "Mid", "Soon after", "Around", "-"]
tags_include = "All Day of 9/11 Events"
entries = []

for i in entries_json:
    if not any(re.findall('|'.join(title_matches), i['title'])) and tags_include in i['tags']:
        soup = BeautifulSoup(i['content'], 'html.parser')
        for a in soup.findAll('cite'):
            a.decompose()
        for b in soup.find_all("span", class_="tmlnImg"):
            b.decompose()
        for c in soup.find_all("a"):
            c.decompose()
        title = i['title']
        title = title.replace("(", "", 1)
        title = title.replace(")", "", 1)
        title = title.replace("a.m.", "AM", 2)
        title = title.replace("p.m.:", "PM", 2)
        title_list = title.split(':')
        time = title.replace(str(title_list[-1]), '')
        time = time.replace('.:', '')
        time = time.replace('.', ':')
        time = time.replace(' September 11, 2001:', '')

        time = time.split('-')[0].strip()

        if time != ':':
            if('PM' in time):
                date_time_obj = datetime.strptime(
                    '2001-09-11 '+ time, '%Y-%m-%d %H:%M %p') + timedelta(hours=12)
            elif('AM' in time):
                date_time_obj = datetime.strptime(
                    '2001-09-11 ' + time, '%Y-%m-%d %H:%M %p')
        startdate = date_time_obj.strftime('%Y-%m-%d %H:%M')
        enddate = date_time_obj + timedelta(minutes=2)
        enddate = enddate.strftime('%Y-%m-%d %H:%M')

        strsoup = str(soup)
        contents_stripped = re.sub('[(]see.*[)]', '', strsoup)

        tags = []
        for tag in i['tags']:
            for taglookup in tags_json:
                if tag == taglookup['description']:
                    tags.append(int(taglookup['id']))

        entry = {
            'start_date': startdate,
            'end_date': enddate,
            'tz': 'EDT',
            'title': title_list[-1].lstrip(),
            'source': i['source'],
            'url': i['url'],
            'format': i['format'],
            'full_title': i['full_title'],
            'tags': tags,
            'content': contents_stripped,
            'approved': 'true',
            'image': i['image'],
            'image_caption': i['image_caption']
        }

        entries.append(entry)

print(json.dumps(entries, sort_keys=False, ensure_ascii=True))
