import { ArrowRight, Plus } from 'lucide-react';
import PublicShell from './PublicShell';
export default function PublicWelcome() {
    return <PublicShell>
        <span className="public-kicker">Добро пожаловать в AVA</span>
        <h1>Ваш бизнес.<br />Всё рядом.</h1>
        <p className="public-description">Начните с нового пространства для бизнеса или вернитесь к своей команде.</p>
        <div className="public-actions">
            <a href="/login" className="public-button">Войти <ArrowRight size={18} aria-hidden="true" /></a>
            <a href="/register" className="public-button secondary"><Plus size={18} aria-hidden="true" /> Создать бизнес</a>
        </div>
        <p className="public-note">Вас пригласили в команду? Откройте ссылку из приглашения — она поможет присоединиться к нужному бизнесу.</p>
    </PublicShell>;
}
