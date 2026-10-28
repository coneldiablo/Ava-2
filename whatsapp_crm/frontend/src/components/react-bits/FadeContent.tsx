// Adapted from React Bits / David Haz. See README.md and LICENSE.md in this directory.
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import './FadeContent.css';

interface FadeContentProps extends HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
    duration?: number;
    easing?: string;
    delay?: number;
    threshold?: number;
    initialOpacity?: number;
}

/** A one-time, subtle reveal. Content remains visible if animation APIs fail. */
export default function FadeContent({
    children,
    duration = 450,
    easing = 'ease-out',
    delay = 0,
    threshold = 0.1,
    initialOpacity = 0.85,
    className,
    style,
    ...props
}: FadeContentProps) {
    const [inView, setInView] = useState(true);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof window.matchMedia !== 'function') return;
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (motion.matches || typeof IntersectionObserver === 'undefined') return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        setInView(false);
        const reveal = () => {
            if (timer) clearTimeout(timer);
            setInView(true);
        };
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            observer.unobserve(element);
            timer = setTimeout(reveal, Math.min(1000, Math.max(0, delay)));
        }, { threshold: Math.min(1, Math.max(0, threshold)) });
        const onMotionChange = () => {
            if (motion.matches) {
                observer.disconnect();
                reveal();
            }
        };
        observer.observe(element);
        motion.addEventListener('change', onMotionChange);
        return () => {
            observer.disconnect();
            motion.removeEventListener('change', onMotionChange);
            if (timer) clearTimeout(timer);
        };
    }, [threshold, delay]);

    return <div
        ref={ref}
        className={`react-bits-fade-content${className ? ` ${className}` : ''}`}
        {...props}
        style={{
            ...style,
            opacity: inView ? 1 : Math.min(1, Math.max(0.85, initialOpacity)),
            transition: inView ? `opacity ${Math.min(1000, Math.max(0, duration))}ms ${easing}` : 'none',
        }}
    >{children}</div>;
}
