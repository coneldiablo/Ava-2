import asyncio, websockets, os
from dotenv import load_dotenv; load_dotenv()

async def test():
    key = os.environ.get('GOOGLE_API_KEY', '')
    url = f'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}'
    try:
        async with websockets.connect(url, extra_headers={'Origin': 'http://localhost:3003'}) as ws:
            print('Connected with Origin!')
    except Exception as e:
        print(f'Error with Origin: {e}')

asyncio.run(test())
