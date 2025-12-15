import { useState } from "react";
import { useLocation } from "wouter";
import { motion, Variants } from "framer-motion";
import { FolderPlus, FileArchive, HardDrive, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";

export default function SourceSelection() {
  const [, setLocation] = useLocation();

  const container: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.2
      }
    }
  };

  const item: Variants = {
    hidden: { opacity: 0, y: 20 },
    show: { 
      opacity: 1, 
      y: 0, 
      transition: { 
        duration: 0.55, 
        ease: [0.25, 0.46, 0.45, 0.94] 
      } 
    }
  };

  const handleSelection = () => {
    setLocation("/workspace");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[400px] h-[400px] bg-secondary/40 rounded-full blur-3xl" />
      </div>

      <motion.div 
        variants={container}
        initial="hidden"
        animate="show"
        className="max-w-[1120px] w-full z-10 flex flex-col items-center text-center"
      >
        <motion.div variants={item} className="mb-8">
          <img src="/Assets/pdr-logo_transparent.png" alt="Photo Date Rescue" className="h-16 w-auto mx-auto mb-6" />
          <h1 className="text-2xl md:text-3xl font-semibold text-foreground tracking-tight leading-[1.1] mb-3">
            Find Your Photos & Videos
          </h1>
          <p className="text-base text-muted-foreground max-w-2xl mx-auto font-light">
            Choose where your photos and videos are located. You can add more sources later.
          </p>
        </motion.div>

        <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-4xl">
          <OptionCard 
            icon={<FolderPlus className="w-8 h-8 text-primary" />}
            title="Add Folder"
            description="Select one or more folders containing photos and videos."
            onClick={handleSelection}
          />
          <OptionCard 
            icon={<FileArchive className="w-8 h-8 text-primary" />}
            title="Add ZIP Archive"
            description="Import backup archives (e.g. phone backups or cloud exports)."
            onClick={handleSelection}
          />
          <OptionCard 
            icon={<HardDrive className="w-8 h-8 text-primary" />}
            title="Add Drive"
            description="Scan an external or internal drive for media files."
            onClick={handleSelection}
          />
        </motion.div>
      </motion.div>
    </div>
  );
}

function OptionCard({ icon, title, description, onClick }: { icon: React.ReactNode, title: string, description: string, onClick: () => void }) {
  return (
    <Card 
      className="flex flex-col items-center text-center p-8 cursor-pointer group h-full justify-between hover:border-primary transition-colors min-h-[280px]"
      onClick={onClick}
    >
      <div className="flex flex-col items-center pt-2">
        <div className="mb-5 p-4 rounded-full bg-secondary text-primary group-hover:scale-110 transition-transform duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]">
          {icon}
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <div className="mt-4 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
         <ArrowRight className="w-5 h-5 text-primary" />
      </div>
    </Card>
  );
}
