import { Outlet, useLocation } from "react-router";

const bare = new Set(["/welcome", "/lock"]);

export default function Layout() {
	const { pathname } = useLocation();
	if (bare.has(pathname)) return <Outlet />;
	return <Outlet />;
}
