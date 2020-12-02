from django.urls import path

from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('networks', views.networks, name='networks'),
    path('formats', views.formats, name='formats'),
    path('tags', views.tags, name='tags'),
    path('tag_types', views.tag_types, name='tag_types'),
    path('collections', views.collections, name='collections'),
]
