import { useState } from "react";
import { motion } from "framer-motion";
import { 
  Folder, 
  FileArchive, 
  HardDrive, 
  Settings, 
  HelpCircle, 
  AlertCircle, 
  CheckCircle2, 
  AlertTriangle,
  ChevronRight,
  Plus,
  Play,
  Database
} from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function Workspace() {
  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <Sidebar />
      <MainContent />
    </div>
  );
}

function Sidebar() {
  return (
    <div className="w-[280px] bg-sidebar border-r border-sidebar-border flex flex-col h-full shrink-0 z-20">
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Database className="text-white w-5 h-5" />
        </div>
        <span className="font-semibold text-lg text-sidebar-foreground tracking-tight">PDR</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Sources</h3>
          <div className="space-y-1">
            <SidebarItem icon={<Folder className="w-4 h-4" />} label="My Vacation Photos" active />
            <SidebarItem icon={<FileArchive className="w-4 h-4" />} label="Google Takeout 2024.zip" />
            <SidebarItem icon={<HardDrive className="w-4 h-4" />} label="Samsung Backup" />
          </div>
          <Button variant="ghost" className="w-full mt-2 justify-start px-2 text-muted-foreground hover:text-primary">
            <Plus className="w-4 h-4 mr-2" /> Add Source
          </Button>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Analysis</h3>
          <div className="px-3 py-3 bg-secondary/50 rounded-xl border border-border">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium">Scanning...</span>
              <span className="text-xs text-muted-foreground">84%</span>
            </div>
            <Progress value={84} className="h-1.5 bg-background" />
            <p className="text-xs text-muted-foreground mt-2">Processing DSC_9921.jpg</p>
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-sidebar-border space-y-1">
        <SidebarItem icon={<Settings className="w-4 h-4" />} label="Settings" />
        <SidebarItem icon={<HelpCircle className="w-4 h-4" />} label="Help & Support" />
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active = false }: { icon: React.ReactNode, label: string, active?: boolean }) {
  return (
    <button className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-200 ${active ? 'bg-secondary text-primary font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent'}`}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MainContent() {
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      {/* Header */}
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center justify-between px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Workspace</span>
          <ChevronRight className="w-4 h-4" />
          <span className="text-foreground font-medium">My Vacation Photos</span>
        </div>
        <div className="flex items-center gap-4">
           <span className="text-sm text-muted-foreground">Last saved: Just now</span>
        </div>
      </header>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          
          {/* Confidence Summary Section */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-foreground mb-1">Confidence Summary</h2>
                <p className="text-muted-foreground">Based on metadata signals found in 1,248 files.</p>
              </div>
              <Button variant="outline" size="sm">View Detailed Report</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ConfidenceCard 
                level="High" 
                count={892} 
                description="Strong agreement between EXIF and filename."
                color="text-emerald-600"
                bgColor="bg-emerald-50"
                borderColor="border-emerald-100"
                icon={<CheckCircle2 className="w-5 h-5" />}
              />
              <ConfidenceCard 
                level="Medium" 
                count={312} 
                description="Partial metadata found, some heuristics used."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-100"
                icon={<AlertTriangle className="w-5 h-5" />}
              />
              <ConfidenceCard 
                level="Low" 
                count={44} 
                description="No reliable date found. Review recommended."
                color="text-rose-600"
                bgColor="bg-rose-50"
                borderColor="border-rose-100"
                icon={<AlertCircle className="w-5 h-5" />}
              />
            </div>
          </section>

          {/* Output Configuration */}
          <section className="pt-4">
            <h2 className="text-2xl font-semibold text-foreground mb-6">Output Selection</h2>
            <Card className="flex flex-col md:flex-row items-center gap-6 p-6">
              <div className="p-4 bg-secondary/50 rounded-full">
                <HardDrive className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium mb-1">Destination Drive</h3>
                <p className="text-sm text-muted-foreground mb-2">/Volumes/Photos_Backup/Restored_2024</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">2.4 TB Free</span>
                  <span className="text-xs text-muted-foreground">Required: 4.2 GB</span>
                </div>
              </div>
              <Button variant="outline">Change Destination</Button>
            </Card>
          </section>

        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="h-20 bg-background border-t border-border flex items-center justify-between px-8 shrink-0 z-10 shadow-[0_-4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center gap-4">
           <div className="text-sm text-muted-foreground">
             <span className="font-medium text-foreground">1,248</span> files ready to process
           </div>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" size="lg">Preview Changes</Button>
          <Button size="lg" className="px-8 shadow-lg shadow-primary/25">
            <Play className="w-4 h-4 mr-2 fill-current" /> Run Rescue
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfidenceCard({ level, count, description, color, bgColor, borderColor, icon }: any) {
  return (
    <Card className={`border ${borderColor} hover:border-opacity-100 transition-colors cursor-default`}>
      <div className="flex justify-between items-start mb-4">
        <div className={`p-2 rounded-lg ${bgColor} ${color}`}>
          {icon}
        </div>
        <span className={`text-xs font-semibold uppercase tracking-wider ${color} bg-opacity-10 px-2 py-1 rounded-full ${bgColor}`}>
          {level} Confidence
        </span>
      </div>
      <div className="text-4xl font-bold text-foreground mb-2">{count}</div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </Card>
  );
}
