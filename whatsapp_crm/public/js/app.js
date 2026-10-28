// app.js - Admin Logic (Russian + Multi-Instance)

const API = {
    get: async (url) => (await fetch(url)).json(),
    post: async (url, body) => (await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })).json(),
    put: async (url, body) => (await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })).json()
};

// State
let instances = [];
let currentInstanceId = null;

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(el => el.style.display = 'none');

        item.classList.add('active');
        const viewId = item.getAttribute('data-view');
        document.getElementById(`view-${viewId}`).style.display = 'block';

        if (viewId === 'instances-mgr') loadInstancesTable();
    });
});

// Instance Selector
document.getElementById('instance-select').addEventListener('change', (e) => {
    loadInstanceData(e.target.value);
});


// --- Logic ---

async function init() {
    await loadInstancesList();
    if (instances.length > 0) {
        loadInstanceData(instances[0].id);
    } else {
        // Show create prompt?
    }
}

async function loadInstancesList() {
    const res = await API.get('/api/instances');
    if (res.success) {
        instances = res.instances;
        const select = document.getElementById('instance-select');
        select.innerHTML = '';
        instances.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.id;
            opt.textContent = inst.name;
            select.appendChild(opt);
        });

        // Update Table if visible
        renderInstancesTable();
    }
}

async function loadInstanceData(id) {
    currentInstanceId = id;
    const instance = instances.find(i => i.id == id);
    if (!instance) return;

    // Fill Settings Form
    document.getElementById('ga-instance').value = instance.greenApiInstance || '';
    document.getElementById('ga-token').value = instance.greenApiToken || '';
    document.getElementById('ai-key').value = instance.openRouterKey || '';
    document.getElementById('ai-model').value = instance.openRouterModel || '';
    document.getElementById('ai-prompt').value = instance.systemPrompt || '';
    document.getElementById('yc-link').value = instance.yclientsLink || '';

    // Update Select (if changed programmatically)
    document.getElementById('instance-select').value = id;
}

async function saveCurrentInstanceSettings() {
    if (!currentInstanceId) return alert('Выберите бизнес');

    const data = {
        greenApiInstance: document.getElementById('ga-instance').value,
        greenApiToken: document.getElementById('ga-token').value,
        openRouterKey: document.getElementById('ai-key').value,
        openRouterModel: document.getElementById('ai-model').value,
        systemPrompt: document.getElementById('ai-prompt').value,
        yclientsLink: document.getElementById('yc-link').value
    };

    const res = await API.put(`/api/instances/${currentInstanceId}`, data);
    if (res.success) {
        alert('Настройки сохранены!');
        await loadInstancesList(); // Refresh lists
        loadInstanceData(currentInstanceId); // Reload form
    } else {
        alert('Ошибка: ' + res.error);
    }
}

// --- Instance Manager ---
function loadInstancesTable() {
    renderInstancesTable();
}

function renderInstancesTable() {
    const tbody = document.querySelector('#instances-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    instances.forEach(inst => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${inst.id}</td>
            <td>${inst.name}</td>
            <td>${inst.greenApiInstance || '-'}</td>
            <td>${inst.openRouterModel || '-'}</td>
            <td>${inst.isActive ? 'Активен' : 'Отключен'}</td>
        `;
        tbody.appendChild(tr);
    });
}

function showCreateInstanceModal() {
    document.getElementById('create-instance-form').style.display = 'block';
}

async function createInstance() {
    const name = document.getElementById('new-inst-name').value;
    if (!name) return alert('Введите название');

    const res = await API.post('/api/instances', { name });
    if (res.success) {
        alert('Бизнес создан!');
        document.getElementById('create-instance-form').style.display = 'none';
        document.getElementById('new-inst-name').value = '';
        await loadInstancesList();
        loadInstanceData(res.instance.id);
    } else {
        alert('Ошибка: ' + res.error);
    }
}


// --- Simulator ---
async function sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;

    addMessage('user', msg);
    input.value = '';

    try {
        const res = await API.post('/api/simulate', {
            message: msg,
            history: [{ role: 'user', content: msg }],
            instanceId: currentInstanceId // Use selected instance
        });

        if (res.success) {
            addMessage('assistant', res.response);
        } else {
            addMessage('assistant', 'Ошибка: ' + res.error);
        }
    } catch (e) {
        addMessage('assistant', 'Ошибка сети');
    }
}

function addMessage(role, text) {
    const div = document.createElement('div');
    div.classList.add('message', role);
    div.textContent = text;
    document.getElementById('chat-messages').appendChild(div);
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

// Start
init();
