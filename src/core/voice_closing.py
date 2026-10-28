"""Conservative, provider independent closing intent for Russian/English calls.

A bare thank-you never triggers the fallback: both participants must close.
Questions, requests and negations always keep the call open.
"""
import re


def normalize(text):
    return " ".join(re.sub(r"[^\w\s]", " ", str(text or "").casefold()).split())


def clear_closing(text):
    value = normalize(text)
    return bool(re.fullmatch(
        r"(?:(?:ну |все |всё |ладно |хорошо |окей |ок |да |спасибо |большое спасибо |вам тоже )*)"
        r"(?:до свидания|до связи|всего доброго|всего хорошего|хорошего (?:вам )?дня|"
        r"хорошего (?:вам )?вечера|пока|пока пока|заверши(?:те)? (?:звонок|разговор)|"
        r"положи(?:те)? трубку|отключи(?:те)? (?:звонок|разговор)|"
        r"goodbye|bye|bye bye|hang up|end (?:the )?call|have a (?:good|great) day)"
        r"(?: (?:спасибо|вам тоже|и вам|пока|до свидания|thanks|thank you))*", value))


def polite_acknowledgement(text):
    return bool(re.fullmatch(
        r"(?:(?:ну |все |всё |ладно |хорошо |окей |ок |да |okay |ok )*)"
        r"(?:спасибо|большое спасибо|спасибо большое|благодарю|thanks|thank you)(?: (?:вам|вас|very much))?",
        normalize(text)))


def mutual_closing(user_text, assistant_text):
    # An acknowledgement after sending information is not permission to hang up.
    # The assistant's own farewell cannot manufacture caller closing intent.
    last_sentence = next((part.strip() for part in reversed(re.split(r"[.!?\n]+", str(assistant_text or ""))) if part.strip()), "")
    return clear_closing(user_text) or (clear_closing(last_sentence) and tool_hangup_allowed(user_text))


def tool_hangup_allowed(user_text):
    return clear_closing(user_text) or normalize(user_text) in {
        "все", "всё", "все спасибо", "всё спасибо", "это все", "это всё", "это все спасибо", "это всё спасибо",
        "ничего не нужно", "больше ничего", "не звоните больше", "thats all", "nothing else"}
