import asyncio, websockets, os
from dotenv import load_dotenv; load_dotenv()

async def test():
    key = os.environ.get('GOOGLE_API_KEY', '')
    url = f'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}'
    try:
        async with websockets.connect(url) as ws:
            print('Connected v1beta!')
    except Exception as e:
        print(f'v1beta Error: {e}')
    
    url2 = f'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={key}'
    try:
        async with websockets.connect(url2) as ws:
            print('Connected v1alpha!')
    except Exception as e:
        print(f'v1alpha Error: {e}')

asyncio.run(test())
