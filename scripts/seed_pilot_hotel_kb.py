#!/usr/bin/env python3
"""
Seed Pilot Hotel Knowledge Base (Stage 4)
Populates 20-30 realistic hotel knowledge base documents and chunks for business_id=1.
"""

import os
import sys
import sqlite3
import hashlib

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.core.onyx_db import DEFAULT_DB_PATH, init_onyx_tables

PILOT_DOCUMENTS = [
    {
        "filename": "hotel_general_rules.txt",
        "title": "Общие правила проживания и заезда",
        "chunks": [
            "Время заезда в отель — с 14:00. Время выезда — до 12:00.",
            "Ранний заезд с 08:00 до 14:00 предоставляется при наличии свободных номеров с доплатой 50% стоимости суток.",
            "Поздний выезд до 18:00 оплачивается в размере 50% стоимости суток, после 18:00 — 100% стоимости суток.",
            "При регистрации заезда гостям необходимо предъявить паспорт РФ или загранпаспорт для иностранных граждан."
        ]
    },
    {
        "filename": "room_categories.txt",
        "title": "Категории номеров и комплектация",
        "chunks": [
            "Категория 'Стандарт': площадь 22 кв.м, двуспальная кровать Queen-size или две раздельные Twin, душ, кондиционер, мини-бар, Wi-Fi, сейф.",
            "Категория 'Супериор': площадь 30 кв.м, кровать King-size, панорамные окна, рабочая зона, кофемашина Nespresso, халаты и тапочки.",
            "Категория 'Люкс / Suite': площадь 55 кв.м, две комнаты (гостиная и спальня), ванна и тропический душ, балкон с видом на парк."
        ]
    },
    {
        "filename": "breakfast_and_dining.txt",
        "title": "Завтраки и ресторан",
        "chunks": [
            "Завтрак 'Шведский стол' сервируется ежедневно в ресторане 'Панорама' на 2 этаже с 07:00 до 11:00 по будням и с 07:30 до 11:30 по выходным.",
            "Стоимость завтрака для гостей без включенного тарифа — 1 500 рублей на взрослого, 750 рублей на ребенка от 6 до 12 лет.",
            "Room Service (доставка еды в номер) работает круглосуточно по внутреннему номеру 102."
        ]
    },
    {
        "filename": "cancellation_policy.txt",
        "title": "Правила отмены и возврата",
        "chunks": [
            "Стандартный тариф: бесплатная отмена бронирования возможна за 24 часа до даты заезда (до 14:00 дня, предшествующего заезду).",
            "Невозвратный тариф: при отмене бронирования или незаезде удерживается полная стоимость первых суток проживания.",
            "Возврат денежных средств при своевременной отмене производится тем же способом оплаты в течение 3-5 рабочих дней."
        ]
    },
    {
        "filename": "spa_and_wellness.txt",
        "title": "СПА-комплекс, бассейн и фитнес",
        "chunks": [
            "СПА-комплекс и крытый подогреваемый бассейн (25 метров) открыты ежедневно с 07:00 до 23:00 для всех гостей отеля бесплатно.",
            "Тренажерный зал оснащен кардио и силовыми тренажерами Technogym, работает круглосуточно.",
            "Финская сауна, хаммам и массажные кабинеты требуют предварительной записи через ресепшен СПА (внутренний номер 105)."
        ]
    },
    {
        "filename": "parking_and_transfer.txt",
        "title": "Парковка и трансфер",
        "chunks": [
            "Подземная охраняемая парковка доступна для гостей отеля по тарифу 800 рублей в сутки. Количество мест ограничено, требуется бронирование.",
            "Индивидуальный трансфер из аэропорта (седан бизнес-класса Mercedes E-class) — 3 500 рублей.",
            "Индивидуальный трансфер из аэропорта (минивэн Mercedes V-class до 6 человек) — 5 500 рублей."
        ]
    },
    {
        "filename": "pet_policy.txt",
        "title": "Размещение с домашними животными",
        "chunks": [
            "В отеле разрешено проживание с собаками и кошками весом до 8 кг при наличии ветеринарного паспорта с отметками о прививках.",
            "Доплата за размещение питомца составляет 2 000 рублей за весь период проживания (включает уборку и предоставление мисок с лежанкой).",
            "Нахождение питомцев в зонах питания (ресторан, бар) и в СПА-комплексе запрещено."
        ]
    },
    {
        "filename": "children_policy.txt",
        "title": "Условия проживания с детьми",
        "chunks": [
            "Дети до 6 лет включительно проживают бесплатно без предоставления отдельного спального места (на кровати с родителями).",
            "Детская кроватка-манеж для детей до 3 лет предоставляется бесплатно по предварительному запросу.",
            "Дополнительное спальное место (евро-раскладушка) для детей от 7 лет и взрослых — 2 000 рублей в сутки с завтраком.",
            "Детская комната с аниматором работает ежедневно с 10:00 до 20:00."
        ]
    },
    {
        "filename": "conference_and_events.txt",
        "title": "Конференц-залы и банкеты",
        "chunks": [
            "Отель располагает 3 трансформируемыми конференц-залами вместимостью от 20 до 250 человек, оснащенными экранами, проекторами и звуковым оборудованием.",
            "Аренда зала 'Гранд Холл' — от 25 000 рублей за 4 часа. Кофе-брейки от 600 рублей на персону.",
            "Для заказа мероприятий обращаться в банкетную службу по телефону или через менеджера."
        ]
    },
    {
        "filename": "wifi_and_tech.txt",
        "title": "Интернет, ТВ и рабочие места",
        "chunks": [
            "Бесплатный высокоскоростной Wi-Fi (до 100 Мбит/с) действует на всей территории отеля: сеть 'Grand_Hotel_Guest'.",
            "Телевизоры Smart TV в номерах поддерживают трансляцию с мобильных устройств (AirPlay / Miracast).",
            "Бизнес-уголок на 1 этаже укомплектован компьютером iMac и цветным МФУ для печати документов."
        ]
    }
]


def seed_database(db_path: str = DEFAULT_DB_PATH, business_id: int = 1):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    init_onyx_tables(conn)

    # 1. Ensure instance exists
    cursor.execute("SELECT id FROM instances WHERE id = ?", (business_id,))
    if not cursor.fetchone():
        cursor.execute("""
            INSERT INTO instances (id, name, businessType, isActive)
            VALUES (?, 'Grand Hotel Pilot', 'hotel', 1)
        """, (business_id,))
        print(f"Created instance #{business_id} (Grand Hotel Pilot)")

    # 2. Seed documents and chunks
    seeded_count = 0
    for doc in PILOT_DOCUMENTS:
        full_text = "\n\n".join(doc["chunks"])
        content_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()

        # Check if doc already exists
        cursor.execute("""
            SELECT id FROM knowledge_base
            WHERE instanceId = ? AND originalName = ? AND isCurrent = 1
        """, (business_id, doc["title"]))
        row = cursor.fetchone()

        if row:
            kb_id = row[0]
            cursor.execute("""
                UPDATE knowledge_base
                SET contentHash = ?, chunkCount = ?, fileSize = ?
                WHERE id = ?
            """, (content_hash, len(doc["chunks"]), len(full_text.encode("utf-8")), kb_id))
            cursor.execute("DELETE FROM kb_chunks WHERE kbId = ?", (kb_id,))
        else:
            cursor.execute("""
                INSERT INTO knowledge_base (
                    instanceId, filename, originalName, contentHash,
                    mimeType, fileSize, chunkCount, isCurrent
                ) VALUES (?, ?, ?, ?, 'text/plain', ?, ?, 1)
            """, (
                business_id,
                doc["filename"],
                doc["title"],
                content_hash,
                len(full_text.encode("utf-8")),
                len(doc["chunks"])
            ))
            kb_id = cursor.lastrowid
            seeded_count += 1

        # Insert chunks
        for idx, chunk in enumerate(doc["chunks"]):
            cursor.execute("""
                INSERT INTO kb_chunks (kbId, chunkIndex, text, section)
                VALUES (?, ?, ?, ?)
            """, (kb_id, idx, chunk, doc["title"]))

    conn.commit()
    conn.close()
    print(f"Successfully seeded/updated {len(PILOT_DOCUMENTS)} knowledge base documents for business #{business_id}.")


if __name__ == "__main__":
    db_arg = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB_PATH
    seed_database(db_path=db_arg)
