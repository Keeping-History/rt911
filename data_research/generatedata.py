import json, re, hashlib
from internetarchive import search_items, get_item, get_files
from pprint import pprint

f = open("ful911-a.csv", "a")
pprint(search_items('collection:"911"'))

for i in search_items('collection:911'):
    item = get_item(i['identifier'])
    fnames = [f.name for f in get_files(i['identifier'], glob_pattern='*mp4')]

    full_url = "https://" + str(item.server) + item.dir + "/" + fnames[0]
    prehash = i['identifier'].encode()
    hashItem = hashlib.md5(prehash).hexdigest()
    regex = r"(?<=(2001 )).*"
    matches = re.finditer(regex, item.item_metadata['metadata']['title'], re.MULTILINE)

    for matchNum, match in enumerate(matches, start=1):
        video_time = str(match.group())

    result = re.sub(r'(?: .*(?:((- )|( \- )|(to) )))', "-", video_time)
    
    f.write(
        item.item_metadata['metadata']['title'] + ";" \
        + hashItem   + ";"  \
        + full_url   + ";"  \
        + "h.264"    +  ";" \
        + result + ";"  \
        + "\n"
)

f.close()
