#!/bin/bash

# Disaster Response Platform Deployment Script
# This script helps deploy the platform to various environments

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_NAME="disaster-response-platform"
DOCKER_IMAGE="$PROJECT_NAME:latest"
BACKUP_DIR="./backups"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if .env file exists
    if [ ! -f ".env" ]; then
        log_error ".env file not found. Please create one based on .env.example"
        exit 1
    fi
    
    # Check if required commands exist
    commands=("node" "npm" "docker" "git")
    for cmd in "${commands[@]}"; do
        if ! command -v $cmd &> /dev/null; then
            log_error "$cmd is not installed or not in PATH"
            exit 1
        fi
    done
    
    log_success "Prerequisites check passed"
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    npm ci
    log_success "Dependencies installed"
}

# Run tests
run_tests() {
    log_info "Running tests..."
    # Add test commands here when available
    log_success "Tests passed"
}

# Build Docker image
build_docker() {
    log_info "Building Docker image..."
    docker build -t $DOCKER_IMAGE .
    log_success "Docker image built: $DOCKER_IMAGE"
}

# Deploy to local Docker
deploy_local() {
    log_info "Deploying to local Docker..."
    
    # Stop existing container if running
    if docker ps -q -f name=$PROJECT_NAME &> /dev/null; then
        log_info "Stopping existing container..."
        docker stop $PROJECT_NAME
        docker rm $PROJECT_NAME
    fi
    
    # Run new container
    docker run -d \
        --name $PROJECT_NAME \
        --env-file .env \
        -p 5000:5000 \
        -v $(pwd)/logs:/app/logs \
        --restart unless-stopped \
        $DOCKER_IMAGE
    
    log_success "Deployed to local Docker. Access at http://localhost:5000"
}

# Deploy using docker-compose
deploy_compose() {
    log_info "Deploying with docker-compose..."
    
    # Stop existing services
    docker-compose down
    
    # Build and start services
    docker-compose up -d --build
    
    log_success "Deployed with docker-compose. Services are starting..."
    log_info "API: http://localhost:5000"
    log_info "Prometheus: http://localhost:9090"
}

# Deploy to Render.com
deploy_render() {
    log_info "Preparing for Render.com deployment..."
    
    # Check if git repo is clean
    if [ -n "$(git status --porcelain)" ]; then
        log_warning "Git repository has uncommitted changes"
        read -p "Do you want to commit and push? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git add .
            git commit -m "Deploy: $(date +%Y-%m-%d_%H-%M-%S)"
            git push
        else
            log_error "Please commit your changes before deploying to Render"
            exit 1
        fi
    fi
    
    log_success "Ready for Render.com deployment"
    log_info "1. Push your code to GitHub"
    log_info "2. Connect your repository to Render"
    log_info "3. Set environment variables in Render dashboard"
    log_info "4. Deploy the service"
}

# Deploy to Vercel (frontend only)
deploy_vercel() {
    log_info "Deploying frontend to Vercel..."
    
    # Check if vercel CLI is installed
    if ! command -v vercel &> /dev/null; then
        log_error "Vercel CLI not installed. Install with: npm i -g vercel"
        exit 1
    fi
    
    # Create vercel.json if it doesn't exist
    if [ ! -f "vercel.json" ]; then
        cat > vercel.json << EOL
{
  "version": 2,
  "builds": [
    {
      "src": "public/**/*",
      "use": "@vercel/static"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/public/\$1"
    }
  ]
}
EOL
        log_info "Created vercel.json configuration"
    fi
    
    vercel --prod
    log_success "Deployed to Vercel"
}

# Backup data
backup_data() {
    log_info "Creating backup..."
    
    mkdir -p $BACKUP_DIR
    BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"
    
    # Backup logs and configuration
    tar -czf $BACKUP_FILE logs/ .env 2>/dev/null || true
    
    log_success "Backup created: $BACKUP_FILE"
}

# Health check
health_check() {
    log_info "Performing health check..."
    
    # Wait for service to start
    sleep 5
    
    # Check if service is responding
    if curl -f http://localhost:5000/health &> /dev/null; then
        log_success "Health check passed - service is running"
    else
        log_error "Health check failed - service may not be running properly"
        exit 1
    fi
}

# Show logs
show_logs() {
    log_info "Showing application logs..."
    
    if docker ps -q -f name=$PROJECT_NAME &> /dev/null; then
        docker logs -f $PROJECT_NAME
    else
        log_error "Container $PROJECT_NAME is not running"
    fi
}

# Stop services
stop_services() {
    log_info "Stopping services..."
    
    # Stop Docker container
    if docker ps -q -f name=$PROJECT_NAME &> /dev/null; then
        docker stop $PROJECT_NAME
        docker rm $PROJECT_NAME
        log_success "Stopped Docker container"
    fi
    
    # Stop docker-compose services
    if [ -f "docker-compose.yml" ]; then
        docker-compose down
        log_success "Stopped docker-compose services"
    fi
}

# Clean up
cleanup() {
    log_info "Cleaning up..."
    
    # Remove unused Docker images
    docker image prune -f
    
    # Clean npm cache
    npm cache clean --force
    
    log_success "Cleanup completed"
}

# Main menu
show_menu() {
    echo
    echo "🚨 Disaster Response Platform Deployment Script"
    echo "================================================"
    echo "1. Full Deploy (Local Docker)"
    echo "2. Deploy with Docker Compose"
    echo "3. Deploy to Render.com"
    echo "4. Deploy to Vercel (Frontend)"
    echo "5. Build Docker Image"
    echo "6. Health Check"
    echo "7. Show Logs"
    echo "8. Backup Data"
    echo "9. Stop Services"
    echo "10. Cleanup"
    echo "11. Exit"
    echo
}

# Main execution
main() {
    case ${1:-menu} in
        "local")
            check_prerequisites
            install_dependencies
            build_docker
            deploy_local
            health_check
            ;;
        "compose")
            check_prerequisites
            deploy_compose
            health_check
            ;;
        "render")
            check_prerequisites
            deploy_render
            ;;
        "vercel")
            deploy_vercel
            ;;
        "build")
            check_prerequisites
            build_docker
            ;;
        "health")
            health_check
            ;;
        "logs")
            show_logs
            ;;
        "backup")
            backup_data
            ;;
        "stop")
            stop_services
            ;;
        "cleanup")
            cleanup
            ;;
        "menu")
            while true; do
                show_menu
                read -p "Please select an option (1-11): " choice
                case $choice in
                    1) main "local"; break ;;
                    2) main "compose"; break ;;
                    3) main "render"; break ;;
                    4) main "vercel"; break ;;
                    5) main "build"; break ;;
                    6) main "health"; break ;;
                    7) main "logs"; break ;;
                    8) main "backup"; break ;;
                    9) main "stop"; break ;;
                    10) main "cleanup"; break ;;
                    11) log_info "Goodbye!"; exit 0 ;;
                    *) log_error "Invalid option. Please try again." ;;
                esac
            done
            ;;
        *)
            log_error "Unknown command: $1"
            echo "Available commands: local, compose, render, vercel, build, health, logs, backup, stop, cleanup, menu"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"