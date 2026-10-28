import pytest
from src.core.voice_closing import clear_closing, mutual_closing, tool_hangup_allowed

@pytest.mark.parametrize('text', ['До свидания!', 'Хорошего вам дня.', 'Спасибо, до свидания', 'Ну всё, пока', 'Завершите звонок', 'Goodbye'])
def test_explicit_goodbye(text):
    assert clear_closing(text)

@pytest.mark.parametrize('text', ['Спасибо, а сколько стоит?', 'Пока не отправляйте', 'До свидания не говорите, я ещё не закончил', 'Хорошего дня, но ещё один вопрос', 'Спасибо', 'Мне нужен аппарат', 'Не завершайте звонок'])
def test_does_not_drop_active_request(text):
    assert not clear_closing(text)


def test_assistant_farewell_cannot_end_call_after_message_acknowledgement():
    assert not mutual_closing('Спасибо', 'Пожалуйста! Хорошего вам дня!')
    assert not mutual_closing('Спасибо', 'Отправил вам в WhatsApp. До свидания!')
    assert not tool_hangup_allowed('Спасибо')
    assert mutual_closing('Всё, спасибо', 'До свидания.')
    assert not mutual_closing('Всё, спасибо', 'Информация отправлена.')
    assert not mutual_closing('Спасибо', 'Нужен вариант с аккумулятором?')
    assert not mutual_closing('Пока не отправляйте', 'До свидания')
    assert not tool_hangup_allowed('Спасибо, расскажите про цену')
