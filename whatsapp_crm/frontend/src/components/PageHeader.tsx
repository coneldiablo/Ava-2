import type { ReactNode } from 'react';
import './ProductUi.css';

export default function PageHeader({ title, eyebrow, description, actions, id }: { title: string; eyebrow?: string; description?: string; actions?: ReactNode; id?: string }) {
    return <header className="ava-page-header">
        <div>{eyebrow && <p className="ava-eyebrow">{eyebrow}</p>}<h1 id={id}>{title}</h1>{description && <p className="ava-page-description">{description}</p>}</div>
        {actions && <div className="ava-page-actions">{actions}</div>}
    </header>;
}
