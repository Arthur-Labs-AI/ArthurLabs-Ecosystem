from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
ROOT=Path('out').resolve()
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
 def translate_path(self,path):
  relative=unquote(urlsplit(path).path).lstrip('/')
  file=(ROOT/relative).resolve()
  if not file.is_relative_to(ROOT): return str(ROOT/'404.html')
  if file.is_dir() and (file/'index.html').exists(): return str(file/'index.html')
  if (not file.exists() or file.is_dir()) and file.with_suffix('.html').exists(): return str(file.with_suffix('.html'))
  return str(file)
ThreadingHTTPServer(('127.0.0.1',3004),Handler).serve_forever()
