import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
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
  Trash2,
  RefreshCw,
  FileImage,
  FileVideo,
  CalendarRange
} from "lucide-react";
import { Button } from "@/components/ui/custom-button";
import { Card } from "@/components/ui/custom-card";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";

interface Source {
  id: string;
  icon: React.ReactNode;
  label: string;
  type: 'folder' | 'zip' | 'drive';
  path?: string;
  active: boolean;
  confirmed: boolean;
}

export default function Workspace() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  
  const [sources, setSources] = useState<Source[]>([
    { id: '1', icon: <Folder className="w-4 h-4" />, label: "My Vacation Photos", type: 'folder', active: true, confirmed: true },
    { id: '2', icon: <FileArchive className="w-4 h-4" />, label: "Google Takeout 2024.zip", type: 'zip', active: false, confirmed: true },
    { id: '3', icon: <HardDrive className="w-4 h-4" />, label: "Samsung Backup", type: 'drive', active: false, confirmed: true }
  ]);

  const [activeSource, setActiveSource] = useState<Source | null>(sources[0]);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const type = params.get("type") as 'folder' | 'zip' | 'drive';
    const name = params.get("name");
    const path = params.get("path");

    if (type && name) {
      const exists = sources.some(s => s.label === name);
      if (!exists) {
        let icon = <Folder className="w-4 h-4" />;
        if (type === 'zip') icon = <FileArchive className="w-4 h-4" />;
        if (type === 'drive') icon = <HardDrive className="w-4 h-4" />;

        const newSource: Source = {
          id: Date.now().toString(),
          icon,
          label: name,
          type,
          path: path || undefined,
          active: true,
          confirmed: false // New sources start unconfirmed
        };

        const updatedSources = sources.map(s => ({ ...s, active: false }));
        setSources([...updatedSources, newSource]);
        setActiveSource(newSource);
      }
    }
  }, [searchString]);

  const handleSourceClick = (id: string) => {
    const updatedSources = sources.map(s => ({ ...s, active: s.id === id }));
    setSources(updatedSources);
    setActiveSource(updatedSources.find(s => s.id === id) || null);
  };

  const handleConfirmSource = () => {
    if (!activeSource) return;
    const updatedSources = sources.map(s => s.id === activeSource.id ? { ...s, confirmed: true } : s);
    setSources(updatedSources);
    setActiveSource({ ...activeSource, confirmed: true });
  };

  const handleRemoveSource = () => {
    if (!activeSource) return;
    const updatedSources = sources.filter(s => s.id !== activeSource.id);
    setSources(updatedSources);
    if (updatedSources.length > 0) {
      updatedSources[0].active = true;
      setActiveSource(updatedSources[0]);
    } else {
      setActiveSource(null);
      setLocation("/source-selection");
    }
  };

  const handleChangeSource = () => {
    handleRemoveSource();
    setLocation("/source-selection");
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <Sidebar sources={sources} onSourceClick={handleSourceClick} />
      <MainContent 
        activeSource={activeSource} 
        onConfirm={handleConfirmSource}
        onRemove={handleRemoveSource}
        onChange={handleChangeSource}
      />
    </div>
  );
}

function Sidebar({ sources, onSourceClick }: { sources: Source[], onSourceClick: (id: string) => void }) {
  return (
    <div className="w-[280px] bg-sidebar border-r border-sidebar-border flex flex-col h-full shrink-0 z-20">
      <div className="px-6 py-8 flex items-center">
        <img src="/Assets/pdr-logo-stacked_transparent.png" alt="Photo Date Rescue" className="h-14 w-auto object-contain" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Sources</h3>
          <div className="space-y-1">
            {sources.map((source) => (
              <SidebarItem 
                key={source.id} 
                icon={source.icon} 
                label={source.label} 
                active={source.active} 
                onClick={() => onSourceClick(source.id)}
              />
            ))}
          </div>
          <Button variant="ghost" className="w-full mt-2 justify-start px-2 text-muted-foreground hover:text-primary">
            <Plus className="w-4 h-4 mr-2" /> Add Source
          </Button>
        </div>

        {/* Only show Analysis if there's at least one confirmed source */}
        {sources.some(s => s.confirmed) && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Analysis</h3>
          <div className="px-3 py-3 bg-secondary/50 rounded-xl border border-border">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium">Preview Mode</span>
            </div>
            <Progress value={0} className="h-1.5 bg-background" />
            <p className="text-xs text-muted-foreground mt-2">Awaiting analysis...</p>
          </div>
        </div>
        )}
      </div>

      <div className="p-4 border-t border-sidebar-border space-y-1">
        <SidebarItem icon={<Settings className="w-4 h-4" />} label="Settings" />
        <SidebarItem icon={<HelpCircle className="w-4 h-4" />} label="Help & Support" />
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, active = false, onClick }: { icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-200 ${active ? 'bg-secondary text-primary font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent'}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function MainContent({ activeSource, onConfirm, onRemove, onChange }: { activeSource: Source | null, onConfirm: () => void, onRemove: () => void, onChange: () => void }) {
  if (!activeSource) {
     return <div className="flex-1 flex items-center justify-center text-muted-foreground">No source selected</div>;
  }

  // If source is not confirmed, show Confirmation Panel
  if (!activeSource.confirmed) {
    return (
      <ConfirmationPanel 
        source={activeSource} 
        onConfirm={onConfirm} 
        onRemove={onRemove}
        onChange={onChange}
      />
    );
  }

  // Otherwise show the standard Workspace Dashboard (Confidence Summary etc.)
  return <Dashboard activeSource={activeSource} />;
}

function ConfirmationPanel({ source, onConfirm, onRemove, onChange }: { source: Source, onConfirm: () => void, onRemove: () => void, onChange: () => void }) {
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC] p-8 items-center justify-center">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl w-full"
      >
        <div className="mb-8 text-center">
           <h2 className="text-2xl font-semibold text-foreground mb-2">Confirm Source Selection</h2>
           <p className="text-muted-foreground">These are example results. Your actual analysis will begin after confirmation.</p>
        </div>

        <Card className="p-8 mb-8">
          <div className="flex items-start gap-6 mb-8 border-b border-border pb-8">
            <div className="p-4 bg-secondary/50 rounded-2xl text-primary">
              <Folder className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-xl font-medium text-foreground mb-1">{source.label}</h3>
              <p className="text-sm text-muted-foreground font-mono bg-muted px-2 py-1 rounded inline-block">
                {source.path || "/Path/To/Selected/Folder"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-8 mb-8">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Total Files</div>
              <div className="text-2xl font-semibold text-foreground">1,248</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Photos / Videos</div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileImage className="w-4 h-4 text-emerald-500" /> 892
                </div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileVideo className="w-4 h-4 text-blue-500" /> 356
                </div>
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Date Range</div>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarRange className="w-4 h-4 text-primary" />
                2018 — 2024
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4">
             <div className="flex gap-4">
                <Button variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
                  <Trash2 className="w-4 h-4 mr-2" /> Remove Source
                </Button>
                <Button variant="ghost" className="text-muted-foreground" onClick={onChange}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Change Source
                </Button>
             </div>
             <Button onClick={onConfirm} className="px-8">
               Confirm & Analyze <ChevronRight className="w-4 h-4 ml-2" />
             </Button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

function Dashboard({ activeSource }: { activeSource: Source }) {
  const [filter, setFilter] = useState<"High" | "Medium" | "Low" | null>(null);

  const toggleFilter = (level: "High" | "Medium" | "Low") => {
    setFilter(current => current === level ? null : level);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8F9FC]">
      {/* Header */}
      <header className="h-16 border-b border-border bg-background/50 backdrop-blur-sm flex items-center justify-between px-8 shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Workspace</span>
          <ChevronRight className="w-4 h-4" />
          <span className="text-foreground font-medium">{activeSource.label}</span>
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
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Preview – example results</span>
            </div>
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
                isActive={filter === "High"}
                onClick={() => toggleFilter("High")}
              />
              <ConfidenceCard 
                level="Medium" 
                count={312} 
                description="Partial metadata found, some heuristics used."
                color="text-amber-600"
                bgColor="bg-amber-50"
                borderColor="border-amber-100"
                icon={<AlertTriangle className="w-5 h-5" />}
                isActive={filter === "Medium"}
                onClick={() => toggleFilter("Medium")}
              />
              <ConfidenceCard 
                level="Low" 
                count={44} 
                description="No reliable date found. Review recommended."
                color="text-rose-600"
                bgColor="bg-rose-50"
                borderColor="border-rose-100"
                icon={<AlertCircle className="w-5 h-5" />}
                isActive={filter === "Low"}
                onClick={() => toggleFilter("Low")}
              />
            </div>
            {filter && (
              <div className="mt-4 p-4 bg-background border border-border rounded-lg text-sm text-muted-foreground flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                 <div className={`w-2 h-2 rounded-full ${filter === 'High' ? 'bg-emerald-500' : filter === 'Medium' ? 'bg-amber-500' : 'bg-rose-500'}`} />
                 Filtering for <strong>{filter} Confidence</strong> files.
              </div>
            )}
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
            <Play className="w-4 h-4 mr-2 fill-current" /> Apply Fixes
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfidenceCard({ level, count, description, color, bgColor, borderColor, icon, isActive, onClick }: any) {
  return (
    <div onClick={onClick} className="relative group cursor-pointer outline-none">
       {/* Active Ring */}
       {isActive && (
         <motion.div 
            layoutId="active-ring"
            className="absolute -inset-[2px] rounded-[20px] border-2 border-primary bg-transparent pointer-events-none z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
         />
       )}
      <Card className={`border ${borderColor} hover:border-opacity-100 transition-all duration-300 ${isActive ? 'bg-white shadow-md scale-[1.01]' : 'hover:scale-[1.01]'}`}>
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
    </div>
  );
}
