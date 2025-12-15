import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { motion, Variants } from "framer-motion";
import { FolderPlus, FileArchive, HardDrive, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";

export default function SourceSelection() {
  const [, setLocation] = useLocation();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const driveInputRef = useRef<HTMLInputElement>(null);

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

  const handleSelection = (type: 'folder' | 'zip' | 'drive') => {
    if (type === 'folder') {
      folderInputRef.current?.click();
      return;
    }
    if (type === 'zip') {
      zipInputRef.current?.click();
      return;
    }
    if (type === 'drive') {
      driveInputRef.current?.click();
      return;
    }
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      // Get the top-level folder name from the first file's path
      // e.g., "Vacation/Photo1.jpg" -> "Vacation"
      const path = e.target.files[0].webkitRelativePath || e.target.files[0].name;
      const folderName = path.split('/')[0] || "Selected Folder";
      // Mock a full path for display purposes
      const fullPath = `/Users/username/Pictures/${folderName}`;
      
      setLocation(`/workspace?type=folder&name=${encodeURIComponent(folderName)}&path=${encodeURIComponent(fullPath)}`);
    }
    e.target.value = '';
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const fileName = file.name;
      const fullPath = `/Users/username/Downloads/${fileName}`;
      
      setLocation(`/workspace?type=zip&name=${encodeURIComponent(fileName)}&path=${encodeURIComponent(fullPath)}`);
    }
    e.target.value = '';
  };

  const handleDriveChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      // For drive, simulate using the file system root
      const driveName = "External Drive (D:)";
      const fullPath = "D:/";
      
      setLocation(`/workspace?type=drive&name=${encodeURIComponent(driveName)}&path=${encodeURIComponent(fullPath)}`);
    }
    e.target.value = '';
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Hidden Folder Input */}
      <input
        type="file"
        ref={folderInputRef}
        className="hidden"
        onChange={handleFolderChange}
        // @ts-expect-error - webkitdirectory is standard in modern browsers but missing in types
        webkitdirectory=""
        directory=""
        multiple
      />

      {/* Hidden ZIP Input */}
      <input
        type="file"
        ref={zipInputRef}
        className="hidden"
        onChange={handleZipChange}
        accept=".zip"
      />

      {/* Hidden Drive Input */}
      <input
        type="file"
        ref={driveInputRef}
        className="hidden"
        onChange={handleDriveChange}
        // @ts-expect-error - webkitdirectory is standard in modern browsers but missing in types
        webkitdirectory=""
        directory=""
        multiple
      />

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
            description="Select a folder on your computer (local or external drives). Scans the folder for media files."
            onClick={() => handleSelection('folder')}
          />
          <OptionCard 
            icon={<FileArchive className="w-8 h-8 text-primary" />}
            title="Add ZIP Archive"
            description="Import a .zip file. Perfect for phone backups, cloud exports, or compressed archives."
            onClick={() => handleSelection('zip')}
          />
          <OptionCard 
            icon={<HardDrive className="w-8 h-8 text-primary" />}
            title="Add Drive"
            description="Scan an entire drive root (internal, external, USB). Searches all folders on the drive."
            onClick={() => handleSelection('drive')}
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
