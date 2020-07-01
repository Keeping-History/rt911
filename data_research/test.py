import json, pprint
from bs4 import BeautifulSoup

with open('entries.json') as data_file:
   data = json.load(data_file)
   for item in data:
      for image in item['images']:
        soup = BeautifulSoup(image, 'html.parser')
        print(soup.img['src'])
        print(soup.img['alt'])
