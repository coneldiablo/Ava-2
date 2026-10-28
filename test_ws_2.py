import asyncio, websockets, os
from dotenv import load_dotenv; load_dotenv()

async def test():
    key = os.environ.get('GOOGLE_API_KEY', '')
    url = f'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}'
    
    models = ["models/gemini-2.5-flash-native-audio-latest", "models/gemini-2.0-flash-realtime-exp", "models/gemini-2.0-flash", "models/gemini-2.0-flash-exp"]
    for model in models:
        try:
            async with websockets.connect(url) as ws:
                await ws.send('{"setup":{"model":"' + model + '","generationConfig":{"responseModalities":["AUDIO"]}}}')
                res = await ws.recv()
                print(f"[{model}] SUCCESS: {res[:100]}")
        except Exception as e:
            print(f"[{model}] ERROR: {e}")

asyncio.run(test())
