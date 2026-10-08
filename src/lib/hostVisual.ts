import type { Host } from "@/data/types";

export interface HostVisualInfo {
	icon: string;
	color: string;
	platformName: string;
}

/**
 * 根据主机名、主机地址、OS 描述、标签智能识别其系统平台/云厂商并赋予专用图标与品牌色
 */
export function getHostVisual(host: Host): HostVisualInfo {
	const raw = `${host.name} ${host.hostname} ${host.os?.name ?? ""} ${(host.tags ?? []).join(" ")}`.toLowerCase();

	if (raw.includes("ubuntu")) {
		return { icon: "icon-[simple-icons--ubuntu]", color: "text-[#E95420]", platformName: "Ubuntu" };
	}
	if (raw.includes("debian")) {
		return { icon: "icon-[simple-icons--debian]", color: "text-[#D70A53]", platformName: "Debian" };
	}
	if (raw.includes("centos")) {
		return { icon: "icon-[simple-icons--centos]", color: "text-[#9391FF]", platformName: "CentOS" };
	}
	if (raw.includes("redhat") || raw.includes("rhel")) {
		return { icon: "icon-[simple-icons--redhat]", color: "text-[#EE0000]", platformName: "Red Hat" };
	}
	if (raw.includes("alpine")) {
		return { icon: "icon-[simple-icons--alpinelinux]", color: "text-[#00D1FF]", platformName: "Alpine" };
	}
	if (raw.includes("arch")) {
		return { icon: "icon-[simple-icons--archlinux]", color: "text-[#1793D1]", platformName: "Arch" };
	}
	if (raw.includes("aws") || raw.includes("amazon") || raw.includes("ec2")) {
		return { icon: "icon-[simple-icons--amazonec2]", color: "text-[#FF9900]", platformName: "AWS EC2" };
	}
	if (raw.includes("docker")) {
		return { icon: "icon-[simple-icons--docker]", color: "text-[#2496ED]", platformName: "Docker" };
	}
	if (raw.includes("mac") || raw.includes("darwin") || raw.includes("apple")) {
		return { icon: "icon-[simple-icons--apple]", color: "text-muted", platformName: "macOS" };
	}
	if (raw.includes("win")) {
		return { icon: "icon-[simple-icons--windows]", color: "text-[#0078D4]", platformName: "Windows" };
	}
	if (raw.includes("google") || raw.includes("gcp")) {
		return { icon: "icon-[simple-icons--googlecloud]", color: "text-[#4285F4]", platformName: "GCP" };
	}
	if (raw.includes("tencent") || raw.includes("腾讯") || raw.includes("cvm") || raw.includes("lighthouse")) {
		return { icon: "icon-[lucide--cloud]", color: "text-primary", platformName: "腾讯云" };
	}
	if (raw.includes("aliyun") || raw.includes("阿里") || raw.includes("ecs")) {
		return { icon: "icon-[lucide--cloud]", color: "text-[#FF6A00]", platformName: "阿里云" };
	}
	if (raw.includes("linux")) {
		return { icon: "icon-[simple-icons--linux]", color: "text-amber-500", platformName: "Linux" };
	}
	return { icon: "icon-[lucide--server]", color: "text-muted", platformName: "Server" };
}
