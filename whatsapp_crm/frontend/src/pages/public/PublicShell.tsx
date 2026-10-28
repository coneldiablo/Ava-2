import type { ReactNode } from 'react';
import { ArrowUpRight, MessageCircle, Sparkles, Users } from 'lucide-react';
import AvaMark from '../../components/AvaMark';
import './PublicIdentity.css';

export default function PublicShell({ children }: { children: ReactNode }) {
    return <div className="public-identity">
        <a className="public-skip" href="#public-content">К содержимому</a>
        <header className="public-header">
            <a className="public-brand" href="/" aria-label="AVA — главная"><span className="public-mark"><AvaMark size={25} /></span> ava<span className="public-brand-caption">для бизнеса</span></a>
            <a className="public-header-link" href="/login">Войти <ArrowUpRight size={16} aria-hidden="true" /></a>
        </header>
        <main className="public-layout" id="public-content">
            <section className="public-story" aria-label="О рабочем пространстве AVA">
                <div className="public-eyebrow"><span /> Единое рабочее пространство</div>
                <h2>Ближе к клиентам.<br /><span>Спокойнее за бизнес.</span></h2>
                <p>Обращения, команда и знания о клиентах — вместе. Освободите время для того, что действительно важно.</p>
                <div className="public-illustration" aria-hidden="true">
                    <div className="public-orbit public-orbit-one" /><div className="public-orbit public-orbit-two" />
                    <div className="public-orbit-center"><AvaMark size={55} /></div>
                    <div className="public-orbit-label public-orbit-clients"><Users size={18} /> Клиенты</div>
                    <div className="public-orbit-label public-orbit-dialogues"><MessageCircle size={18} /> Диалоги</div>
                    <div className="public-orbit-label public-orbit-knowledge"><Sparkles size={18} /> Знания</div>
                </div>
                <div className="public-story-footer"><span>Меньше рутины.</span><span>Больше внимания людям.</span></div>
            </section>
            <section className="public-card">{children}</section>
        </main>
        <footer className="public-footer">AVA · Рабочее пространство вашего бизнеса</footer>
    </div>;
}
