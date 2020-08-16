import scrapy
import re
from bs4 import BeautifulSoup
from pprint import pprint
from urllib.parse import urlsplit


class BlogSpider(scrapy.Spider):
    name = 'blogspider'
    start_urls = [ 'http://www.historycommons.org/timeline.jsp?timeline=complete_911_timeline']

    def parse(self, response):

        for item in response.css('div.i'):
            images = item.css('span.tmlnImg>img').getall()

            if(len(images) > 0):
                soup = BeautifulSoup(images[0], "html.parser")
                img_url = soup.find('img')['src']
                imagenew = urlsplit(img_url)._replace(query=None).geturl()
            else:
                imagenew = ""

            yield {
                'title': item.css('div.iT>h2>a::text').get(),
                'content': item.css('p').get(),
                'tags': item.css('div.t * a::text').getall(),
                'citations': item.css('p>cite').getall(),
                'images': item.css('span.tmlnImg').getall(),
                'url': 'http://historycommons.org/' + item.css('div.iT>h2>a').attrib['href'],
                'id': item.css('div.i>a:first-child').attrib['name'],
                'tz': 'EDT',
                'source': 'History Commons',
                'format': 'html',
                'full_title': item.css('div.iT>h2>a::text').get() + ' - History Commons',
                'image': imagenew,
                'image_caption': item.css('span.caption::text').get()
           }

            for next_page in response.css('div.timeline-paging a:last-of-type'):
                yield response.follow(next_page, self.parse)
