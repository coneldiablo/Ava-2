# WhatsApp CRM Assistant v3.0 (React + AITunnel)

**Современный AI-ассистент для бизнеса с поддержкой WhatsApp, AITunnel и мульти-аккаунтов.**

---

## � Основные возможности

1.  **Мульти-аккаунтость**: Управляйте несколькими бизнесами (номерами) из одной админки.
2.  **AI Мозги**:
    *   Поддержка **AITunnel** для ответов модели.
    *   Отдельная модель и ключ для embeddings/RAG.
    *   **Универсальный JSON формат** для управления статусами CRM.
3.  **Интеграции**:
    *   **OpenWA**: Основной автономный Open-Source WhatsApp шлюз (без сторонних подписок).
    *   **Green API**: Резервный шлюз (автоматический Fallback при недоступности OpenWA).
    *   **YClients**: Автоматическая отправка ссылок на запись.
4.  **Admin Panel**:
    *   Современный интерфейс на **React + TypeScript + Tailwind**.
    *   Симулятор чата для тестирования промптов.
    *   Настройка температуры и формата ответов.

---

## 🛠️ Установка и Запуск

### Требования
- **Node.js** v18+
- **OpenWA** (локально или в Docker на порту 2785) — основной WhatsApp шлюз
- **Green API** (опционально) — резервный шлюз для отказоустойчивости
- Учетная запись **AITunnel** (для AI-ответов)

### 1. Установка зависимостей

```bash
# Корень (Бэкенд)
npm install

# Фронтенд
cd frontend
npm install
```

### 2. Сборка Фронтенда

Перед запуском сервера нужно собрать React-приложение:

```bash
cd frontend
npm run build
cd ..
```

### 3. Запуск Сервера

```bash
npm start
```

Сервер запустится на порту `3000`.

*   **Админ панель**: [http://localhost:3000](http://localhost:3000)
*   **Webhook URL**: `http://YOUR_SERVER_IP:3000/api/webhook`

---

## ⚙️ Настройка (Через Админку)

Вам больше не нужно править `.env` файлы для настройки бизнесов. Всё делается в UI:

1.  Зайдите в **Manage Businesses**.
2.  Создайте новый бизнес (Instance).
3.  Зайдите в **Integrations**:
    *   **Green API**: Введите `IdInstance` и `ApiToken`.
    *   **AI Brain**: Выберите провайдера (например, **YandexGPT**).
    *   **System Prompt**: Опишите роль бота и прайс-лист.
4.  Нажмите **Save Changes**.

---

## 🧠 Настройка YandexGPT (Universal JSON)

Чтобы бот мог менять статусы лидов и предлагать запись:

1.  В **Integrations** выберите **Response Format: JSON Object**.
2.  В **Yandex AI Studio** (если используете системный промпт там) добавьте схему:

```json
{
  "thought": "Internal reasoning...",
  "reply": "Message to user...",
  "status": "new | audit | offer | booked",
  "action": "none | send_yclients"
}
```

---

## � Структура проекта

```
project/
├── frontend/             # React Admin Panel
│   ├── src/
│   └── dist/             # Собранный фронтенд
├── src/
│   ├── services/
│   │   ├── ai.service.js       # Логика AI (Yandex/OpenAI)
│   │   ├── whatsapp.service.js # Логика WhatsApp
│   │   └── database.service.js # SQLite (crm_v2.db)
│   ├── routes/           # API эндпоинты
│   └── app.js            # Express сервер
├── crm_v2.db             # База данных
└── server.js             # Точка входа
```

---

## 🐛 Решение проблем

**1. Бот не отвечает**
*   Проверьте лог консоли.
*   Убедитесь, что Webhook в Green API настроен на ваш сервер.
*   Убедитесь, что в **Manage Businesses** инстанс активен.

**2. Ошибка "AI Response Error"**
*   Проверьте API Key.
*   Если YandexGPT - проверьте `Folder ID`.

**3. Фронтенд не грузится**
*   Попробуйте пересобрать: `cd frontend && npm run build`
*   Очистите кэш браузера.
