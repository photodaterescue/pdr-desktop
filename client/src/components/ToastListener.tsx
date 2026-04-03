import { useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';

export function ToastListener() {
  const { toast } = useToast();

  useEffect(() => {
    const handleToast = (event: CustomEvent) => {
      const { type, title, message, duration } = event.detail;
      
		  toast({
			variant: 'default',
			title: title,
			description: message,
			duration: duration || 5000,
			className: type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200' : undefined,
		  });
    };

    window.addEventListener('pdr-toast', handleToast as EventListener);
    return () => window.removeEventListener('pdr-toast', handleToast as EventListener);
  }, [toast]);

  return null;
}