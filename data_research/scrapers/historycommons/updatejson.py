import json, re
from bs4 import BeautifulSoup

entries_json = json.load(open('entries.json'))

#for i in entries_json:
#    print(
#            len(re.split("\September[\s][0-9][0-9], 2001+", i['title'])),
#            re.split("\September[\s][0-9][0-9], 2001+", i['title'])
#        )

entries = []

for i in entries_json:
    soup = BeautifulSoup(i['contents'], 'lxml')
    for a in soup.findAll('cite'):
        a.decompose()
    for b in soup.find_all("span", class_="tmlnImg"):
        b.decompose()
    entries.append(str(soup))

print(json.dumps(entries))