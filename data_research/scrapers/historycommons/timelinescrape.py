import scrapy
import re
from bs4 import BeautifulSoup


class BlogSpider(scrapy.Spider):
    name = 'blogspider'
    start_urls = [
        'https://web.archive.org/web/20200526030224/http://www.historycommons.org/timeline.jsp?timeline=complete_911_timeline']

    def parse(self, response):

        for item in response.css('div.i'):
            yield {
                'title': item.css('div.iT>h2>a ::text').get(),
                'contents': item.css('p').get(),
                'tags': item.css('div.t * a::text').getall(),
                'citations': item.css('p>cite').getall(),
                'images': item.css('span.tmlnImg').getall(),
            }

            for next_page in response.css('div.timeline-paging a:last-of-type'):
                yield response.follow(next_page, self.parse)
